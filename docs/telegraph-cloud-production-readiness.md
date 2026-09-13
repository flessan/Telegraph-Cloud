# Telegraph Cloud production readiness — Phase 6C

**Operational-hardening status:** `Phase 6C`

**Audit snapshot:** 2026-09-13 (Asia/Singapore)

**Scope:** deployment safety, recovery, privacy-safe diagnostics/signals, and operating guidance. This phase does **not** add an S3 protocol operation or broaden S3 compatibility.

> [!IMPORTANT]
> Telegraph Cloud is a self-hosted, Telegram-backed object/document engine with Cloudflare KV materialization. It is not Amazon S3, R2, SQL/PostgreSQL, a relational or ACID database, a public file CDN, an audit system, a secret vault, a global rate limiter, or an unlimited-performance service. Telegram remains an internal persistence transport. `/upload`, `/file/*`, the legacy dashboard, `img_url`, R2 behavior, `/api/manage/*`, `/api/db/*`, `/api/projects/*`, and `/api/storage/*` remain separate surfaces.

Read this guide together with the [Phase 2 database reference](telegraph-cloud-phase-2-document-database.md), [Phase 3 projects/key reference](telegraph-cloud-phase-3-projects-and-developer-api-keys.md), [Phase 4 object-engine reference](telegraph-cloud-phase-4-object-storage.md), [Phase 5 listing/range reference](telegraph-cloud-phase-5-object-semantics.md), [Phase 5.1 index-repair guide](telegraph-cloud-phase-5-1-index-repair.md), and [Phase 6B SigV4 reference](telegraph-cloud-phase-6b-sigv4.md). The older [Phase 6A note](telegraph-cloud-phase-6a-s3-protocol.md) is historical only.

## 1. Deployment audit result — not yet production-approved

The repository homepage identified `https://telestorage.pages.dev` as its public Pages target during this audit. Only safe unauthenticated requests were made; no deployment variable, binding, credential, object, Telegram message, project, or production secret was changed.

| Check | Observation | Result |
| --- | --- | --- |
| Git candidate | The Phase 6B/6C work branch is ahead of `origin/main`; Cloudflare Pages deployment settings were not available to this environment. | A deployment of this branch must be selected explicitly; a Git push alone does not prove Pages is serving it. |
| Public legacy setup status | `GET /api/config` returned a ready legacy setup with Telegram storage and the dashboard reported as configured. This endpoint intentionally says nothing about Telegraph Cloud KV, peppers, S3 endpoint matching, or Bot API reachability. | Legacy configuration signal only. It is **not** evidence that Phase 6B S3 is configured. |
| Public S3-route probe | An anonymous safe request to a never-created `/s3/...?...` target returned the landing-page HTML, not an S3 XML authentication error. | The observed public target was not serving the Phase 6B `/s3/*` route at audit time, or a Pages routing/deployment configuration intercepted it. It cannot be accepted as an S3 deployment. |
| Cloudflare account inspection | `npx wrangler whoami` reported that this environment is not authenticated. | Production/Preview Pages variables, secret values, bindings, deployment history, KV namespace identity, and Pages project settings could not be inspected. |
| Real mutation smoke | No safe account-authorized path to create temporary projects/credentials or write a Telegram-backed test object was available. | The required external smoke was **not run**. Follow [the staged smoke procedure](#5-exact-staged-external-smoke) after an authorized deployment. |

This is deliberately a negative result, not an inference that the public deployment is broken permanently. The public endpoint may be tied to another branch or deployment. Until the manual audit and staged smoke pass against the intended Preview and Production targets, the readiness state is **local-code verified; external deployment/configuration unverified**.

## 2. Pages configuration audit checklist

Cloudflare Pages applies variables/bindings per environment. Audit **Production** and **Preview** independently in the Pages dashboard; do not assume one inherits from the other. Mark secrets as secrets in the Pages UI, never copy values into tickets, screenshots, source control, browser storage, or terminal history.

### 2.1 Exact names and separation

> [!WARNING]
> JavaScript binding names are case-sensitive. This repository reads `TG_Bot_Token` and `TG_Chat_ID` (mixed case), not the all-uppercase spellings `TG_BOT_TOKEN` and `TG_CHAT_ID`. Setting only the all-uppercase names leaves the application unconfigured. The spelling is retained for legacy compatibility.

| Pages setting | Kind | Needed for | Production and Preview audit rule |
| --- | --- | --- | --- |
| `BASIC_USER` | Secret/configuration value | Dashboard session/Basic fallback and all `/api/projects/*` administration, including diagnostics and S3 credential lifecycle. | Both `BASIC_USER` and `BASIC_PASS` must be set together. An incomplete pair fails project administration closed. Use a distinct value per environment. |
| `BASIC_PASS` | Secret | Same as above. | Verify presence only; never reveal it. Set a separate `SESSION_SECRET` as well when dashboard sessions are enabled. |
| `TG_Bot_Token` | Secret | Legacy Telegram upload and Telegraph Cloud immutable documents/object bytes/events. | Verify the exact mixed-case name and that the bot remains authorized for the intended channel. Do not substitute `TG_BOT_TOKEN`. |
| `TG_Chat_ID` | Secret/configuration value | Same Telegram data plane. | Verify the exact mixed-case name and that the bot can post. Do not substitute `TG_CHAT_ID`; do not expose the ID. |
| `API_KEY_PEPPER` | Secret, 32–4,096 UTF-8 bytes | `tg_live_…` Developer-key creation/verification and existing protected object-list/index-repair continuation tokens. | A unique high-entropy value per environment. It must be distinct from all other secrets, especially the S3 pepper. |
| `TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER` | Secret, 32–4,096 UTF-8 bytes | One-time S3-secret derivation/verification and S3 continuation tokens. | A unique high-entropy value per environment. Required for `/s3/*`; never reuse `API_KEY_PEPPER`. |
| `TELEGRAPH_CLOUD_S3_ENDPOINT_HOST` | Non-secret configuration | Strict header-form SigV4 endpoint binding. | Exact public host used by clients, optionally with a non-default port; no scheme, path, wildcard, or trailing route. It must match both the public request host and signed `host`. |
| `TELEGRAPH_CLOUD_S3_MAX_CLOCK_SKEW_SECONDS` | Non-secret optional configuration | SigV4 UTC acceptance window. | Omit for the 300-second default, or use a decimal value from 1 through 900. Prefer the smallest window compatible with managed client clocks. |
| `img_url` | KV namespace binding | Existing dashboard media metadata, albums, short links, moderation cache. | Bind the existing legacy namespace only where those features are required. It is not Telegraph Cloud control-plane storage. |
| `TELEGRAPH_CLOUD_KV` | **Separate** KV namespace binding | Projects, credential metadata/verifiers, document/object materializations, manifests, revisions, bounded list indexes, outboxes, and repair state. | Bind a dedicated namespace with this exact binding name. Never point it at `img_url`; do not use a production namespace in Preview unless that shared-data risk is intentional and reviewed. |

`SESSION_SECRET` is strongly recommended as a separate dashboard-session secret. `UPLOAD_BASIC_USER`/`UPLOAD_BASIC_PASS`, R2 `img_r2`, and moderation bindings remain legacy feature choices and are not substitutes for the Telegraph Cloud settings above.

### 2.2 Manual Pages audit sequence

For **Preview** first, then **Production**:

1. Confirm that the Pages project is a **Pages** project with this repository/desired branch and root output. This repository has file-based Functions; do not deploy it as a Worker with `wrangler deploy`.
2. Confirm the deployment commit includes `functions/s3/_middleware.js`, `functions/s3/[[path]].js`, `functions/api/health.js`, and `functions/api/projects/diagnostics.js`.
3. In **Settings → Environment variables**, verify each row in the table by **name, environment, and secret/non-secret type only**. Do not open/copy a secret to prove it exists.
4. In **Settings → Functions → KV namespace bindings**, verify both `img_url` and `TELEGRAPH_CLOUD_KV` where required, and verify they are different namespace IDs. Do not expose either ID in support material.
5. Redeploy after any variable/binding change. Pages Functions receive deployment configuration; changing a setting is not a retroactive update to an already-running deployment.
6. Check the public and authenticated endpoints in the next section. Only after they are green should a temporary S3 project/credential smoke be authorized.

This phase does not automatically alter Pages settings, rotate secrets, bind a namespace, or deploy to Production.

## 3. Minimal health and authenticated diagnostics

### Public: `GET /api/health`

The new public endpoint returns exactly one non-secret status:

```json
{"status":"ok"}
```

or:

```json
{"status":"degraded"}
```

It is `no-store` and only reflects the existing legacy upload setup check. It does **not** call Telegram, probe KV, reveal a binding/secret/identifier, assert S3 readiness, or prove a deployment is healthy. Use it for a low-information load-balancer/synthetic check, not a release sign-off.

`GET /api/config` remains the existing public, enum-only legacy setup response. It is useful for the dashboard but also does not attest to `TELEGRAPH_CLOUD_KV`, either pepper, the S3 host, or Bot API delivery.

### Operator: `GET /api/projects/diagnostics`

This route inherits the fail-closed dashboard authentication under `/api/projects/*`: both `BASIC_USER` and `BASIC_PASS` must be configured and the caller must have an existing dashboard session or send valid Basic credentials. Developer Bearer keys and S3 credentials cannot use it.

The response contains only bounded enum states, for example:

```json
{
  "status": "ready_for_smoke",
  "checks": {
    "dashboard_auth": "configured",
    "legacy_storage": "configured",
    "cloud_kv": "readable",
    "telegram_configuration": "configured",
    "telegram_api": "not_probed",
    "api_key_verifier": "configured",
    "s3_credential_verifier": "configured",
    "s3_endpoint": "configured",
    "cloud_object_engine": "ready_for_smoke",
    "s3_adapter": "ready_for_smoke"
  }
}
```

It never returns a secret, secret length, hostname, KV namespace ID/value, Telegram bot/chat record, project, credential, raw provider error, or raw configuration value.

| Check | What a passing state means | What it does **not** prove |
| --- | --- | --- |
| `dashboard_auth` | The Basic pair is complete. | That every credential was distributed safely. |
| `legacy_storage` | The selected legacy Telegram/R2 provider has the expected configuration shape. | A successful upload/download. |
| `cloud_kv: readable` | The binding exposes the required KV method shape and a fixed **read-only** probe succeeded. The probe ignores the returned value and performs no KV write/list/delete. | Cross-edge propagation, quota, write/list/delete availability, data correctness, or atomicity. |
| `telegram_configuration` | The exact legacy-compatible bot-token/chat-ID bindings are non-empty. | Bot API connectivity, channel permission, upload/download, or Telegram retention behavior. |
| `telegram_api` | With `?probe=telegram`, a one-shot authenticated Bot API `getMe` returned `ok: true`. | Channel permission, `sendDocument`, file download, persistence, or any Telegram ID. |
| `api_key_verifier` / `s3_credential_verifier` | The relevant pepper has an acceptable non-empty byte length. | That previously issued credentials are compatible after a rotation. |
| `s3_endpoint` | The fixed endpoint host and optional bounded skew value parse safely. | That it matches the public Pages hostname or that a client can sign it correctly. |
| `cloud_object_engine` / `s3_adapter` | The configuration/read-only prerequisites are sufficient to run the staged smoke. | An actual Telegram/KV object mutation, exact SigV4 transport behavior, or distributed health. |

`GET /api/projects/diagnostics?probe=telegram` is deliberately opt-in. It makes one `getMe` call with no retry, discards the response record, and returns only `reachable` or `unreachable`. It is not a channel/write probe. Any other or repeated `probe` parameter is rejected with `400 {"error":"invalid_diagnostic_probe"}`.

Use ephemeral variables supplied by a secret manager rather than pasting a password into a terminal history. The endpoint response itself is safe to inspect, but the HTTP Basic credential is not:

```bash
curl --fail --silent --show-error "$TELEGRAPH_CLOUD_BASE_URL/api/health"
curl --fail --silent --show-error \
  --user "$TELEGRAPH_CLOUD_DASHBOARD_USER:$TELEGRAPH_CLOUD_DASHBOARD_PASS" \
  "$TELEGRAPH_CLOUD_BASE_URL/api/projects/diagnostics"
curl --fail --silent --show-error \
  --user "$TELEGRAPH_CLOUD_DASHBOARD_USER:$TELEGRAPH_CLOUD_DASHBOARD_PASS" \
  "$TELEGRAPH_CLOUD_BASE_URL/api/projects/diagnostics?probe=telegram"
```

A `ready_for_smoke` result is intentionally not called “healthy.” It is a prerequisite gate, not a substitute for the external signed mutation/read smoke below.

## 4. Privacy-safe operational signals

Application Sentry telemetry already uses a small header allowlist and is now further constrained as follows:

- dynamic `/api/storage`, `/s3`, `/api/projects`, `/api/db`, `/api/manage`, and `/file` resources are represented as route shapes rather than raw object paths, IDs, or project internals;
- Authorization/cookie/API-key/token/secret/signature headers are redacted and unrecognized headers are omitted;
- Telegram Bot API tokens, resource paths, and named Telegram chat/file identifier fields are redacted;
- a canonical request, string-to-sign, SigV4 Authorization fragment, payload hash, request body, nested breadcrumb/context field, or secret-shaped field is redacted rather than retained;
- a full URL embedded in an automatic error/span message is sanitized too: query values are dropped, known dynamic application paths are shaped, and Cloudflare account-scoped provider paths are reduced to a provider resource marker;
- caught legacy `/upload` provider/runtime failures now return the opaque `upload_failed` code (and malformed non-multipart input returns `invalid_upload_request`) with `no-store`, while logs use a fixed line. The pre-existing locally generated missing-file/configuration messages remain value-free, but no upstream body, Bot URL/token, chat identifier, caller metadata, or arbitrary caught error is echoed/logged;
- sampled API transactions receive only bounded `telegraph_cloud.route_family` and `telegraph_cloud.response_class` tags; the diagnostics endpoint may add the fixed enum `operator_readiness:ready_for_smoke` or `operator_readiness:degraded`;
- these tags are not a counter, billing meter, audit log, per-project signal, or analytics feature. Arbitrary caller data cannot be passed to the signal helper.

The dedicated `/s3/*` middleware intentionally does not add application Sentry/console request telemetry. It returns its safe XML/error/request-ID envelope only. Cloudflare platform logs, WAF logs, and any externally configured telemetry are outside this application scrubber; configure their retention/redaction independently and never enable request-body/Authorization capture for these paths.

Set `disable_telemetry=true` to disable the application’s remote telemetry integration. This does not disable Cloudflare platform logging.

`test/telemetry-security.test.js` covers malformed/automatic Sentry event scrubbing, a real-shaped Developer key, S3 access key, Telegram URL, canonical request, signature, payload hash, request body, nested breadcrumb/context data, raw dynamic routes, bounded response outcome tags, and rejection of an arbitrary operational-signal value.

## 5. Exact staged external smoke

The checked-in `scripts/telegraph-cloud-staged-smoke.cjs` is the exact procedure used after an authorized deployment. It is intentionally **not** an npm script and refuses to run until its explicit confirmation variable is set.

> [!CAUTION]
> This smoke creates two temporary projects, one-time S3 credentials, and a small Telegram-backed immutable test object/event sequence. Its cleanup attempts to tombstone any known test object, revokes known credentials, and logically deletes known projects. A timeout during create/rotate can still leave unreturned credential metadata that the script cannot recover; inspect/revoke safe metadata manually. Telegram/KV history or retained immutable bytes may remain; cleanup is not a physical-erasure promise. Run it only in a designated test project/channel or after an explicit Production change approval.

### Preconditions

1. Deploy the exact release candidate to an isolated Preview target first. Confirm that its `TELEGRAPH_CLOUD_S3_ENDPOINT_HOST` equals the host in `TELEGRAPH_CLOUD_SMOKE_BASE_URL`.
2. Audit all settings in [Section 2](#2-pages-configuration-audit-checklist), then obtain dashboard credentials through an approved secret manager. Do not put a bot token, pepper, S3 secret, or dashboard password in the command line, a shell profile, a ticket, or a captured CI log.
3. Confirm `/api/health`, `/api/projects/diagnostics`, and `/api/projects/diagnostics?probe=telegram` pass. The script checks those gates before it writes anything.
4. Use HTTPS for a remote target. The script permits plain HTTP only for `localhost`/`127.0.0.1` local test doubles.

```bash
# Values must be supplied ephemerally by an approved secret manager/session.
export TELEGRAPH_CLOUD_SMOKE_BASE_URL='https://s3-preview.example.invalid'
export TELEGRAPH_CLOUD_SMOKE_DASHBOARD_USER="$YOUR_APPROVED_DASHBOARD_USER"
export TELEGRAPH_CLOUD_SMOKE_DASHBOARD_PASS="$YOUR_APPROVED_DASHBOARD_PASS"
export TELEGRAPH_CLOUD_SMOKE_CONFIRM='I_UNDERSTAND_THIS_WRITES_TELEGRAM'
node scripts/telegraph-cloud-staged-smoke.cjs
```

The tool prints fixed step names only. It never prints a project ID, access key, one-time secret, Basic credential, Authorization header, signature, canonical request, payload hash/body, endpoint response, or raw object path. A failure is intentionally generic; inspect only the authenticated diagnostics and protected operator logs.

| Ordered assertion | Expected safe outcome |
| --- | --- |
| Public/minimal health and authenticated diagnostics | Health returns `ok`; both readiness gates return `ready_for_smoke`; active Telegram probe says `reachable`. |
| Project and credential issuance | Two temporary dashboard-managed projects and one-time S3 credentials are created. No credential value is printed. |
| Primary signed object flow | Header-form SigV4 `PUT`, `GET`, `HEAD`, single-byte `Range`, and `ListObjectsV2` succeed using fixed region `us-east-1`, service `s3`, and exact payload hashes. |
| Cross-project non-visibility | A second valid project credential requesting the first project’s same bucket/key receives `404 NoSuchKey`, never the first project’s bytes. |
| Inactive project behavior | The second temporary project is disabled and its otherwise-valid S3 request receives `403 AccessDenied`. |
| Planned replacement | Dashboard rotation creates a replacement; the old credential receives `403 InvalidAccessKeyId`, and the replacement successfully reads the first project object. |
| Logical deletion | The replacement signs `DELETE`; a following request receives `404 NoSuchKey`. This is not a physical Telegram deletion assertion. |
| Compromised-credential revocation | The replacement is explicitly revoked; its otherwise-valid signed request receives `403 InvalidAccessKeyId`. |
| Cleanup | The utility attempts a logical tombstone before revoking known test credentials and logically deleting the temporary projects. It reports success only if its known cleanup completed; unknown network outcomes may still leave unreturned active metadata, so see [Section 7](#7-unknown-outcomes-and-recovery). |

The smoke utility has a local HTTP-double test in `test/staged-production-smoke.test.js`. That test verifies the sequence and verifies that fixture access keys, secrets, payload, signature marker, and dashboard password do not appear in process output. It is not a substitute for the authorized remote smoke.

## 6. Credential revocation, replacement, and emergency pepper rotation

### 6.1 A compromised individual S3 credential

For a confirmed or suspected leaked `secret_access_key`, prefer **revoke first** over planned rotation:

1. Stop/reconfigure the compromised client and preserve only the safe credential metadata necessary to identify its project/`access_key_id`. Do not paste the secret into a support record.
2. With dashboard authentication, list the project’s S3 credential metadata and send `DELETE /api/projects/:projectId/s3-credentials/:accessKeyId` for the compromised credential.
3. Treat an old signed request returning `403 InvalidAccessKeyId` as the expected post-revocation result. Cloudflare KV is eventually consistent: this is not a promise that every edge rejected it globally at the same instant.
4. Create a fresh credential with `POST /api/projects/:projectId/s3-credentials`, store its one-time secret in the client secret manager, and destroy any transient local copy.
5. Verify the new credential with a least-privilege signed `HEAD`/`GET` against a known test object, then run the normal client health check. Do not use a client-provided project selector.
6. Re-list safe metadata and investigate unexpected active credentials. Repeating an already-completed credential revoke is safe.

This causes client downtime between revocation and rollout of the replacement. For a planned, non-compromise change, `POST /api/projects/:projectId/s3-credentials/:accessKeyId/rotate` creates a replacement and then revokes the old credential. It returns the replacement one-time secret once. It is not atomic: a network/KV failure can leave an administrator needing to list/revoke safe metadata, and a secret from an unreturned response cannot be recovered.

Disabling a project is a broader emergency stop. S3 checks the project after a valid signature and returns `403 AccessDenied` for inactive/deleted project state. It also has the same KV propagation limitation and does not physically erase Telegram data.

### 6.2 Emergency rotation: `API_KEY_PEPPER`

`API_KEY_PEPPER` is the verifier root for all issued `tg_live_…` Developer keys and the existing protected object-list/index-repair continuation tokens. It is **not** the S3 credential pepper.

Changing it has an unavoidable compatibility impact:

- existing Developer keys no longer authenticate (`401 invalid_api_key` on the relevant Developer-key surfaces);
- outstanding protected list/repair continuation tokens cannot be resumed and must be restarted;
- existing documents, objects, projects, KV manifests/outboxes, and immutable Telegram data are not deleted or re-encrypted by the change;
- there is no dual-pepper or non-disruptive overlap mechanism. Plan a maintenance window.

Emergency procedure:

1. Declare a key-verification incident, stop callers using old Developer keys, and inventory project/key safe metadata with dashboard access. Listing and explicit revocation remain recovery tools; they do not reveal old plaintext keys.
2. Generate a new independent high-entropy secret in an approved secret manager. Do not generate it in a logged shell or commit it.
3. Set the new `API_KEY_PEPPER` as a **Secret** in Preview, redeploy Preview, check diagnostics, create a temporary Developer key, test the least-privilege route, and confirm an old key is rejected.
4. During the approved Production window, set the new Production secret and redeploy. Expect Developer-key downtime until new keys are issued and clients are updated.
5. Create fresh Developer credentials per project (or use the dashboard rotation flow for an active metadata record), distribute each one-time value securely, then explicitly revoke old metadata as appropriate. A failed create/rotation must be followed by safe metadata inspection/revocation; never assume a missing response can be replayed to recover a secret.
6. Verify each replacement with a minimal authenticated database/storage request, confirm old keys reject, restart any interrupted list/index-repair operation with a new continuation token, and retain an incident record without secrets.

If the old pepper is lost rather than suspected compromised, recovery is the same: existing Developer credentials cannot be made valid again; issue fresh ones after deploying a new pepper. Do not roll back to an unknown/possibly compromised pepper merely to avoid downtime.

### 6.3 Emergency rotation: `TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER`

This separate pepper derives/verifies every S3 `secret_access_key` and protects S3 continuation tokens. Replacing it invalidates all issued S3 secrets/tokens. Existing S3 requests fail safely (normally `403 InvalidAccessKeyId` at the external XML boundary), while the Telegram/KV object data itself remains intact.

Emergency procedure:

1. Stop affected S3 clients and inventory safe dashboard credential metadata. Do not try to validate an old secret by copying it into a ticket/shell.
2. Generate a new independent high-entropy Secret. Set it in Preview first, redeploy, run diagnostics and the isolated staged smoke, and document the expected total S3 credential outage.
3. In the approved Production window, set the new S3 pepper and redeploy. There is no overlapping old/new S3-secret verifier, so this is disruptive by design.
4. Create fresh S3 credentials for each required project with the dashboard-only create endpoint; place each one-time secret directly in the client’s secret manager. Restart S3 list operations rather than reusing old continuation tokens.
5. Verify each new credential with signed `HEAD`/`GET` and a controlled `PUT`/`DELETE`; verify old known credentials are rejected. List/revoke old metadata as an incident-cleanup action. A revocation write after the change uses the newly derived verifier; do not claim it revokes a credential instantly at all edges.
6. Inspect safe metadata for unexpected active entries and keep the old pepper unavailable to clients. Do not reuse `API_KEY_PEPPER` or restore the old S3 pepper for convenience.

Do not rotate both peppers together unless an incident requires it: doing so combines Developer-key and S3-client downtime and makes diagnosis/recovery harder. Neither operation is automatic in this repository.

## 7. Unknown outcomes and recovery

### KV, revocation, and inactive-project consistency

Cloudflare KV is eventually consistent and has no distributed compare-and-swap/transaction guarantee. A credential revoke, project disable/delete, list-index materialization, or repair write is visible according to KV propagation, not as an instantaneous global event. Do not advertise “immediate global revocation,” atomic rotation, serializable writes, or an ACID recovery process.

S3 authentication uses a direct primary credential lookup and checks active project state after a successful signature. Stale list metadata does not itself authorize an S3 request. Nonetheless, a geographically stale read can temporarily see old control-plane state; reduce blast radius with least-privilege credentials, short operational response, and Cloudflare edge controls.

### Telegram/KV multi-step persistence

A Telegraph Cloud object mutation writes bounded KV intent/outbox state, uploads immutable bytes to Telegram, records an immutable event, then materializes revision/manifest/bucket/list-index state in KV. A delete creates a logical tombstone; it deliberately does not promise Telegram `deleteMessage`, physical erasure, or provider-retention control.

If Telegram accepts a byte/event but a later KV stage cannot be confirmed, the application returns a safe retryable pending/backend failure rather than a false success. There is no background reconciliation worker that can truthfully declare every pending state repaired.

For `PUT`/`DELETE` recovery:

1. Treat a timeout, connection reset, `503`/S3 `ServiceUnavailable`, or `object_mutation_pending` as **unknown**, not as success or failure.
2. Do not change the object path/body/metadata. Retry the **same** request with the **same** `Idempotency-Key`; for S3, include that header in `SignedHeaders` and recompute the exact request signature/body hash for the retry.
3. If the outbox already has the staged pointer, the retry can complete materialization without another byte upload. If failure happened before that pointer was durable, a duplicate retained Telegram byte can be possible; the system does not claim exactly-once physical delivery.
4. Do not reuse an idempotency key for a different operation, object, body, MIME type, or metadata. That is a conflict, not a recovery shortcut.
5. Escalate prolonged pending/KV failures through authenticated operator access. Preserve only safe timestamps/statuses; never manually invent a manifest/pointer or edit arbitrary KV keys from an incident shell.

### Stale object listing and index repair

Object list leaves are a bounded secondary index derived from current manifests. A list can lag a direct object read after propagation/failure; it is not a full bucket scan or a second authority. Use the dashboard-only `POST /api/projects/:projectId/storage/index-repair` flow:

1. Start with its bounded `dry_run` mode and retain only its safe progress counts/checkpoint.
2. Use `apply` only after reviewing the intended project and operation. It reads manifests, does not read object bytes, and makes deterministic missing/stale leaf repairs.
3. Resume only with the opaque project-bound checkpoint returned by the prior operation. If a pepper rotation invalidated a checkpoint, start a new bounded repair; do not decode or synthesize one.
4. Concurrent mutations can change a page while repair runs. Re-run a bounded pass as needed and do not claim a global atomic snapshot.

## 8. Rate limits: application-local versus Cloudflare edge controls

The following guards already exist in application isolate memory. They reduce an accidental burst only; each is reset on isolate turnover, held in a bounded local map, and is **not** global, durable, exact, per-account billing, or a substitute for Cloudflare edge enforcement.

| Surface | Existing local guard | Important gap |
| --- | --- | --- |
| `/api/db/*` | `POST`/`PATCH`/`DELETE`: 20 mutations/60 seconds per authenticated Developer project or dashboard identity. | No distributed limit; reads and malformed auth are not covered. |
| `/api/storage/*` | `PUT`/`DELETE`: 20 mutations/60 seconds per authenticated project. | No distributed limit; invalid Bearer requests run before this authenticated guard. |
| `/s3/*` | `PUT`/`DELETE`: 20 mutations/60 seconds per credential-derived project after successful SigV4 authentication. | Invalid keys/signatures, GET/HEAD/LIST, and separate isolates are not covered. Do not call this DDoS protection. |
| `/api/projects/*` | `POST`/`PATCH`/`DELETE`: 30 mutations/60 seconds per dashboard identity, including credential lifecycle and index repair. | Dashboard GET/diagnostic probes and distributed abuse need edge controls. |
| Legacy `/upload`, `/file/*`, `/api/manage/*` | No new Telegraph Cloud local request limit was added. Telegram upload retries/upstream limits and legacy configuration remain separate. | A public upload can be abused if optional upload authentication/edge controls are absent. |

Recommended Cloudflare configuration, tested in Preview before Production:

1. Put dashboard and project-management paths behind Cloudflare Access (or another approved identity boundary) in addition to application Basic/session protection. Include `/admin`, `/api/manage/*`, and `/api/projects/*`; protect any custom-domain Pages route actually used by operators.
2. Create **rate limiting rules** scoped by host, path prefix, and HTTP method, with thresholds appropriate to the deployment’s Telegram and KV budgets. Suggested separate groups are: `/api/projects/*` management mutations; `/s3/*` `PUT`/`DELETE`; `/api/storage/*` `PUT`/`DELETE`; and legacy `/upload` POST.
3. Add a separate per-IP/ASN edge rule for `/s3/*` requests that lack an Authorization header and for obviously abusive request volume. Do not inspect/store an Authorization value, signature, canonical request, or payload body in a WAF/log rule.
4. Use Cloudflare WAF custom rules/managed challenge/block actions for known abusive networks and request-size/method restrictions where available. Tune from observed safe aggregate errors, not from raw credentials or object paths.
5. Rate-limit control-plane credential/project mutations more aggressively than reads, restrict management to approved identities/IPs where appropriate, and enable alerts on aggregate `4xx/5xx/429` trends.
6. Verify rule support for the actual custom domain/Pages deployment plan. A `pages.dev` hostname and a custom proxied zone may not expose the same zone-level controls. Do not claim a rule protects a host until a Preview test confirms it.

Cloudflare edge rate rules generally match request attributes and count traffic; they do not magically know that a later application response was an invalid SigV4 signature. Keep the application’s strict authentication/error behavior and use edge volume controls as a separate layer.

## 9. Focused final security review

The final code/document review confirmed the following boundaries:

- S3 remains header-form `AWS4-HMAC-SHA256` only, with fixed `us-east-1`/`s3`, exact configured host, bounded UTC skew, exact bounded body SHA-256, strict duplicate/ambiguous-input rejection, credential-derived project/scopes, and safe XML failures.
- S3 credential secrets and Developer-key plaintext are one-time reveal values. KV contains verifier/metadata control state, not plaintext secrets; Telegram does not receive client credential/pepper material.
- S3 project/scope selection is server-derived. Basic/session, Developer Bearer keys, caller project hints, bucket names, and headers do not select S3 authority.
- Project isolation, inactive-project rejection, individual revoke/replacement, logical deletion, range/list boundaries, and raw-object non-visibility are covered by focused unit tests and the reviewed staged-smoke procedure.
- Public health is intentionally small; operator diagnostics are Basic/session protected and enum-only. The optional Bot API probe discards bot data and does not claim channel/write readiness.
- Telemetry redaction now covers the operationally sensitive S3/Telegram structures described above, including embedded provider URLs/spans. `/s3/*` does not add application request telemetry.
- Legacy `/upload` and moderation failure paths preserve their existing success/fail-open control flow, but no longer reflect or log caught upstream exception detail; the opaque `upload_failed` provider/runtime error is intentional privacy hardening.

Remaining operational limits are intentional and must remain visible in a deployment decision:

- no real Production/Preview secret/binding audit or remote write smoke was possible from this environment;
- KV/control-plane revocation, project disable/delete, and indexes are eventually consistent, not globally instantaneous or transactional;
- Telegram and KV cross-system mutation recovery is staged/repairable, not atomic or exactly-once; immutable Telegram retention may outlive logical deletion;
- S3 header signing may be replayed inside its configured clock window. There is no durable nonce/replay database; signed idempotency is retry identity, not replay prevention;
- local isolate guards are not distributed abuse protection; production requires appropriately tested Cloudflare edge controls;
- no presigned URLs, multipart, bucket CRUD, ACL/policies, CopyObject, tagging, checksums, SSE, object lock, broader S3 API, AWS SDK certification, billing, analytics, or dashboard redesign was added.

## 10. Release gate

Mark a target ready only when all of the following are recorded without secrets:

- [ ] Exact Pages deployment commit/branch and target hostname recorded.
- [ ] Production and Preview configuration matrix in Section 2 checked by name/type/binding separation.
- [ ] `GET /api/health` returns `ok`; authenticated diagnostics return `ready_for_smoke`; optional Telegram probe returns `reachable`.
- [ ] `TELEGRAPH_CLOUD_S3_ENDPOINT_HOST` exactly matches the external test host.
- [ ] Preview staged smoke passes, including non-visibility, inactive-project, revoke, and replacement checks.
- [ ] Production staged smoke passes under approved change control, or an explicit risk owner accepts why it was not performed.
- [ ] Cloudflare Access/WAF/rate-limit rules were tested against the actual hostname and edge behavior is documented separately from isolate-local guards.
- [ ] Pepper emergency contacts, maintenance expectations, and safe credential recreation process are tested by tabletop/rehearsal.
- [ ] Full repository tests, syntax checks, diff whitespace check, Pages/Wrangler local smoke, and legacy plus `/s3/*` regressions pass for the release commit.

A green code test suite alone does not satisfy this gate. Conversely, do not expose a secret merely to turn a status green.
