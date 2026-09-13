# Telegraph Cloud Phase 6B — bounded S3 SigV4 access

> **Status:** implemented as a deliberately narrow, self-hosted S3-compatible
> protocol adapter. This is not an S3/R2 replacement, an AWS SDK certification,
> a public file host, a credential vault, or an unlimited-performance service.
>
> Phase 6B supersedes the temporary Phase 6A dashboard-Basic/test-project
> bridge. `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` is not read by production S3
> routing anymore. The historical Phase 6A reference is retained only for
> migration context.

Phase 6B adds real **header-form AWS Signature Version 4** verification to the
existing dedicated `/s3/*` adapter. It does not move object logic into the S3
layer or alter legacy upload, public `/file/*`, dashboard, `/api/db/*`,
`/api/projects/*`, or `/api/storage/*` behavior.

```text
S3 client
  -> AWS4-HMAC-SHA256 Authorization header
  -> strict SigV4 syntax parse + direct S3 access-key metadata lookup in TELEGRAPH_CLOUD_KV
  -> full canonical-request / derived-HMAC verification
  -> credential-derived active project + s3:read/s3:write scopes
  -> dedicated S3 XML protocol adapter
  -> existing project-bound object facade
  -> Telegram immutable bytes/events + repairable KV manifests/indexes
```

Telegram remains the object-byte/event persistence adapter. Raw Telegram file,
message, chat, revision, KV, and outbox identifiers stay internal; neither the
S3 XML interface nor its error responses expose them. The SigV4 verifier,
request-target parser, S3 error marker, and shared request-body/header helpers
are dependency-light: they do not import the object engine, Telegram adapter,
or KV implementation. The dedicated protocol adapter receives only the
project-bound object facade.

---

## 1. Required configuration

Configure these as Cloudflare bindings/secrets for the deployment that serves
the public S3 endpoint. Do not expose a secret in client JavaScript, a
Dashboard response, Telegram, object metadata, error text, or telemetry.

| Binding / secret | Required | Policy |
| --- | --- | --- |
| `TELEGRAPH_CLOUD_KV` | Yes | Dedicated Cloud KV namespace for project state, S3 credential metadata, object manifests, indexes, and repair/outbox state. It must not be the legacy `img_url` namespace. |
| `TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER` | Yes | A distinct random Cloudflare **Secret**, UTF-8 length 32–4,096 bytes; for example `openssl rand -base64 48`. It derives/transiently verifies S3 credential secrets and encrypts/authenticates Phase 6B S3 continuation tokens under separate domain labels. Replacing it invalidates all issued S3 credentials and outstanding S3 continuation tokens. |
| `TELEGRAPH_CLOUD_S3_ENDPOINT_HOST` | Yes | Exact public **path-style** endpoint host, optionally with a non-default port, such as `s3.example.com` or `s3.example.com:8443`. Use no scheme, path, wildcard, userinfo, or comma. Every SigV4 `host` value must match the received endpoint and this policy. |
| `TELEGRAPH_CLOUD_S3_MAX_CLOCK_SKEW_SECONDS` | No | Decimal 1–900 seconds; default `300`. Small, bounded UTC signing window. |
| `TELEGRAPH_CLOUD_MAX_OBJECT_BYTES` | Existing | Applies to a PUT body as before (default 10 MiB; hard maximum 20 MiB). SigV4 reads a bounded clone to hash exact bytes before the adapter reads the original branch. |
| `BASIC_USER` / `BASIC_PASS` | For credential administration | Existing dashboard authentication. These are never S3 request credentials. |

`API_KEY_PEPPER` still governs the separate `tg_live_…` Developer Bearer-key
and earlier object-list/repair facilities. It is **not** an S3 signing secret.
Keep it distinct from `TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER`.

An endpoint configured as `s3.example.com:443` is equivalent to
`s3.example.com` on HTTPS; a non-default port must be present both in the
configured host and in the signed `host` header. IPv6-literal endpoint hosts
are intentionally outside this narrowly configured adapter surface.

---

## 2. S3 developer credential lifecycle

### 2.1 Authority and storage model

Only the dashboard-authenticated project control plane can issue or manage S3
credentials. Developer Bearer keys (`tg_live_…`), existing S3 credentials,
request headers, request query values, request paths, request bodies, and
proxy identity headers cannot create, list, revoke, rotate, select, or change
an S3 credential.

A credential has:

- a server-generated opaque 128-bit-random access-key ID,
  `tgsk_live_<base64url-id>`;
- a cryptographically derived secret access key returned **once** at creation
  or rotation;
- immutable project ID and `s3:read` and/or `s3:write` scopes;
- optional bounded label, creation/update timestamps, active/revoked status,
  optional rotation lineage, and a best-effort `last_used_at` marker;
- a direct primary KV record keyed by access-key ID and a bounded per-project
  metadata list index; and
- a verifier/fingerprint rather than stored plaintext secret material.

The random access-key ID is the per-credential entropy. The worker derives the
matching client secret transiently using a domain-separated HMAC under the
server-only S3 credential pepper. KV persists only a domain-separated HMAC
verifier/fingerprint and safe metadata. It persists neither a plaintext secret
nor an encrypted client-secret envelope, and Telegram persists neither. The
verifier binds authorization-relevant access key, project, scopes, active vs.
revoked status, and creation data, so an accidental metadata alteration cannot
silently produce different authority.

The service performs one bounded direct primary lookup for a signed
access-key ID; it never scans the project list or all credential records during
S3 authentication. The project list is only for dashboard administration. Its
pagination cursor is an HMAC-authenticated, project-bound opaque wrapper around
the bounded KV list cursor; a caller cannot forge or move it to another
project. The wrapped cursor has its own 2 KiB wire limit (to accommodate
base64url and HMAC overhead around the bounded inner cursor).

`last_used_at` is a non-authoritative best-effort usage record. A failed usage
write never makes a valid object operation fail and can never restore a
revoked primary credential. It is not audit/billing/analytics data.

### 2.2 Dashboard-only endpoints

All endpoints below inherit `/api/projects/*` dashboard authentication: both
`BASIC_USER` and `BASIC_PASS` must be configured, and the existing Basic or
HMAC dashboard session must authenticate. Responses set `Cache-Control:
no-store`.

| Method | Endpoint | Request JSON | Result |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/s3-credentials` | Optional `{ "label": "CI", "scopes": ["s3:read", "s3:write"] }` | `201`; safe credential metadata and the one-time `secret_access_key`. Omitted scopes default to both. |
| `GET` | `/api/projects/:projectId/s3-credentials?limit=&cursor=` | None | Bounded, HMAC-authenticated opaque-cursor metadata list. Secrets/verifiers are omitted. |
| `DELETE` | `/api/projects/:projectId/s3-credentials/:accessKeyId` | None | Revokes the credential. Repeating a successful revocation is safe. |
| `POST` | `/api/projects/:projectId/s3-credentials/:accessKeyId/rotate` | Optional replacement label/scopes | `201`; creates a replacement, then revokes the old credential. The replacement secret appears exactly in this response. |

Labels are display metadata, not authorization. The only accepted scopes are
`"s3:read"` and `"s3:write"`; at least one is required. A credential ID from a
different project is reported as not found by the project management API rather
than disclosing its owning project.

There is intentionally no secret retrieval endpoint. Save the returned secret
in a client-side secret manager at creation/rotation time. Do not use Telegram,
object metadata, browser storage, or source control as a secret manager.

**Rotation policy:** a successful rotation response means the previous key was
immediately marked revoked; Phase 6B provides no intentional planned-overlap
mode. The replacement primary record must be written before the old record can
be revoked, and Cloudflare KV is eventually consistent, so neither ordering nor
revocation propagation is a global transactional guarantee. The service does
not return the replacement secret if its attempt to revoke the old credential
fails; operators should inspect the bounded list and revoke unexpected active
records after a control-plane outage.

KV is globally eventually consistent and does not offer a multi-key
transaction/CAS primitive. Creation writes a primary record and bounded project
listing record; the service makes partial creation cleanup best-effort and
never reveals a secret if creation fails. Rotation creates a replacement then
revokes the old credential; concurrent administrator operations still require
an operator to list, verify, and revoke unexpected active credentials. This is
an honest control-plane consistency limitation, not ACID credential storage.

### 2.3 Example management response shape

The following is illustrative only. It contains no usable secret:

```json
{
  "secret_access_key": "returned-once-and-not-shown-again",
  "credential": {
    "access_key_id": "tgsk_live_exampleopaqueaccesskeyid",
    "project_id": "prj_AbCd1234",
    "label": "CI deploy",
    "fingerprint": "safeFingerprint",
    "scopes": ["s3:read", "s3:write"],
    "status": "active",
    "created_at": "2026-09-13T08:00:00.000Z",
    "updated_at": "2026-09-13T08:00:00.000Z"
  }
}
```

The example string is a placeholder, not a valid key. List/revoke responses
contain only the nested safe credential fields (and may include
`last_used_at`); they never repeat `secret_access_key`, verifier, pepper, bot
token, or internal pointer.

---

## 3. Header-form SigV4 policy

Phase 6B accepts **only** `AWS4-HMAC-SHA256` Authorization-header requests.
There are no query-signed/presigned URLs, SigV2, bearer substitutions,
temporary security tokens, streaming/chunked signatures, or
`UNSIGNED-PAYLOAD` mode.

### 3.1 Fixed scope

Every successful Authorization header has this fixed credential scope:

```text
<access-key-id>/YYYYMMDD/us-east-1/s3/aws4_request
```

- algorithm: `AWS4-HMAC-SHA256` only;
- region: `us-east-1` only;
- service: `s3` only;
- terminal: `aws4_request` only.

The client does not choose another region or service. The endpoint does not
infer a project from an S3 bucket name, request header, query parameter, path,
or body; it derives exactly one project from verified credential metadata.

An accepted header shape is:

```text
Authorization: AWS4-HMAC-SHA256 Credential=tgsk_live_<opaque-id>/20260913/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=<64-lowercase-hex>
```

The parser accepts the conventional comma separator with zero or one ASCII
space, but rejects malformed fields, unsupported algorithms/scopes, invalid
signatures, repeated/merged Authorization values, tab/repeated separator
whitespace, missing required fields, invalid signed-header ordering, duplicate
signed names, and forbidden hop-by-hop/proxy/cookie Authorization inputs.

### 3.2 Required signed headers and endpoint binding

The client must send and sign all of these:

- `host` — exact configured endpoint host, including a non-default port;
- `x-amz-date` — UTC `YYYYMMDDTHHMMSSZ`;
- `x-amz-content-sha256` — lowercase SHA-256 hex of exact received bytes.

Every `x-amz-*` header present must be in `SignedHeaders`. If present, object
semantic headers must also be signed: `content-type`, `idempotency-key`,
conditional headers, and `range`. A signed header value is trimmed and runs of
spaces/tabs collapse to one space under standard SigV4 canonicalization. The
adapter rejects a comma-coalesced signed value rather than guessing whether it
represents one value or repeated security-sensitive header lines. Fetch/Pages
does not expose original duplicate field lines reliably, so fail-closed
canonicalization is intentional.

The signed `host`, the actual received request URL host, and
`TELEGRAPH_CLOUD_S3_ENDPOINT_HOST` must all agree. Do not sign a private origin
or `localhost` from a browser client when the public Pages endpoint is the
actual request host.

### 3.3 Canonical URI and query rules

The verifier uses the raw request-target representation made available to
Pages; it does not apply a second filesystem/object-key normalization before
signing.

- Repeated slashes, trailing slash form, and percent escape spelling in the
  available pathname remain significant to the canonical S3 URI.
- The route decodes a segment once *after* signature verification for the
  existing object-key validator. Encoded `/` and `\` are rejected rather than
  becoming a different hierarchy after routing.
- The service does not make dot-path behavior a compatibility promise; do not
  use dot-like path forms. URL normalization before a Pages Function is outside
  the object engine and cannot safely become storage-key semantics.
- The raw query parser is byte/UTF-8 strict. It preserves repeated names,
  empty values, and literal `+`; it does not use form-style `URLSearchParams`
  decoding where `+` becomes a space.
- Query names and values are strict-percent-decoded to UTF-8 bytes, encoded
  with RFC 3986/SigV4 rules (uppercase escapes and `%20`, never `+`), sorted by
  encoded name/value, then serialized as `name=value`.
- Malformed percent/UTF-8 input, empty `&&` components, oversized query input,
  or security-sensitive query controls fail closed. All `x-amz-*` query
  parameters are rejected, which disables presigned URLs. Project,
  credential/token/secret/signature-style query names are also rejected.

The narrow object adapter separately validates bucket/key grammar and does not
silently give ACL, copy, tagging, checksum, encryption, object-lock, temporary
security-token, or other unsupported `x-amz-*` behavior meaning.

### 3.4 Payload, time, and replay posture

For each request, the verifier clones and bounded-reads the request body,
hashes those exact bytes, and compares the resulting fixed-size digest against
`x-amz-content-sha256`. The original request branch remains for the existing
object adapter. This necessarily uses bounded memory twice across the two
branches; do not raise the documented object-size cap casually.

- `PUT` may have bytes up to the existing bounded object limit.
- `GET`, `HEAD`, and `DELETE` must hash an empty body; a non-empty body fails.
- `Content-Encoding` is rejected: this narrow object facade stores/serves exact
  buffered bytes and does not promise encoded-representation delivery.
- `UNSIGNED-PAYLOAD`, streaming payload variants, and a mismatched hash fail.
- `x-amz-date` must be valid UTC, must share its calendar date with the
  credential scope, and must fall within the configured clock skew.
- The final derived-key HMAC comparison uses the runtime Web Crypto
  `subtle.verify('HMAC', ...)` operation, not JavaScript string equality. The
  payload digest comparison has fixed work over its fixed-size bytes. The
  implementation deliberately relies on the runtime cryptographic
  implementation for final MAC comparison and makes no stronger hardware or
  cross-runtime timing promise.

A header-form SigV4 request can be replayed until its timestamp leaves the
bounded skew window. Phase 6B has no durable nonce/replay database because that
would add distributed state/availability semantics outside this narrow adapter.
Use the default or smaller skew, TLS, short-lived/rotated/revocable
credentials, and a signed `Idempotency-Key` for engine write retry identity
when appropriate. Idempotency avoids compatible repeated object mutation work;
it is not general replay prevention.

---

## 4. Supported S3-shaped surface and scopes

This remains a path-style dedicated route, not `/api/storage/*`:

| Request | Required scope | Behavior |
| --- | --- | --- |
| `GET /s3/:bucket?list-type=2…` | `s3:read` | Bounded `ListObjectsV2` only. Deterministic key ordering, bounded `max-keys`, opaque continuation tokens, and existing prefix/delimiter/start-after behavior apply. |
| `GET /s3/:bucket/:key` | `s3:read` | Existing object GET, conditions and valid single range behavior. |
| `HEAD /s3/:bucket/:key` | `s3:read` | Existing object metadata/condition behavior, no body. |
| `PUT /s3/:bucket/:key` | `s3:write` | Existing bounded object facade; safe `x-amz-meta-*`, content type, conditions, and signed `Idempotency-Key` flow through. |
| `DELETE /s3/:bucket/:key` | `s3:write` | Existing logical object deletion/conditions/idempotency flow through. |

`GET /s3/:bucket` must explicitly request `list-type=2`. Bucket markers are
still materialized by the first successful object PUT; there is no
CreateBucket/DeleteBucket API.

Deliberately deferred/not implemented: presigned URLs, multipart, bucket CRUD,
ACLs/policies, temporary tokens, copy object, tagging, checksum APIs,
server-side encryption, object lock, advanced policy semantics, billing,
analytics, public delivery, AWS SDK certification, or a dashboard redesign.

Responses retain the adapter's safe S3 XML/selected headers and opaque request
IDs. Errors do not echo Authorization values, access-key IDs, secrets,
canonical requests, body data, raw object internals, Telegram/KV IDs, project
metadata, revisions, or upstream diagnostics.

---

## 5. Non-secret signing example

A standard SigV4 client must calculate the payload hash, canonical request,
string-to-sign, and AWS4 derived HMAC key. This illustrative request contains
only placeholders — do **not** paste a real access key or secret into a shell
history, source file, issue, or log:

```bash
# The dashboard POST response is shown once. Load both values from a client-side
# secret manager instead of hardcoding them.
export S3_ENDPOINT='https://s3.example.com'
export S3_ACCESS_KEY_ID='tgsk_live_<opaque-id>'
export S3_SECRET_ACCESS_KEY='<one-time-secret-from-dashboard>'
export AMZ_DATE="$(date -u +%Y%m%dT%H%M%SZ)"
export DATE_STAMP="${AMZ_DATE:0:8}"

# For bytes in ./hello.txt, a conforming signer sends these signed headers:
# host: s3.example.com
# x-amz-date: $AMZ_DATE
# x-amz-content-sha256: $(openssl dgst -sha256 -r ./hello.txt | cut -d' ' -f1)
#
# Credential scope: $DATE_STAMP/us-east-1/s3/aws4_request
# SignedHeaders: host;x-amz-content-sha256;x-amz-date
# Authorization: AWS4-HMAC-SHA256 Credential=$S3_ACCESS_KEY_ID/$DATE_STAMP/us-east-1/s3/aws4_request, SignedHeaders=..., Signature=<derived-64-lowercase-hex>
#
# Send the exact same bytes that were hashed:
# curl --data-binary @./hello.txt -X PUT "$S3_ENDPOINT/s3/assets/hello.txt" \
#   -H "host: s3.example.com" -H "x-amz-date: $AMZ_DATE" \
#   -H "x-amz-content-sha256: <hash>" -H "Authorization: <derived-header>"
```

Set client region to `us-east-1`, service to `s3`, and use header signing, not
presigning. Client libraries can emit unsupported S3 operations or headers, so
successful use of an individual library is not an AWS SDK compatibility claim;
inspect its outgoing request and keep it within the supported table above.

---

## 6. Phase 6A migration

1. **Do not enable or rely on the old test bridge.** Remove
   `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` from deployment configuration. It is no
   longer an authority input and does not restore Basic/session access to
   `/s3/*`.
2. Bind `TELEGRAPH_CLOUD_KV` and configure a new independent
   `TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER` plus the exact public
   `TELEGRAPH_CLOUD_S3_ENDPOINT_HOST`.
3. Create/confirm the project using the existing dashboard-only project API.
   Under that project, create narrowly scoped S3 credentials through the new
   dashboard-only route and save the returned secret once.
4. Configure clients for `us-east-1`, service `s3`, path-style `/s3/:bucket`,
   header-form `AWS4-HMAC-SHA256`, exact payload hashes, and the configured
   endpoint host. Test a bounded PUT, ListObjectsV2, GET/HEAD, and DELETE with
   least-privilege scopes.
5. Treat Phase 6A outer continuation tokens as invalid. Phase 6B deliberately
   uses the separate S3 credential pepper/domain, avoiding coupling to
   `API_KEY_PEPPER`.
6. Revoke/rotate credentials through the dashboard as needed. Changing the S3
   credential pepper is emergency-wide invalidation, not normal individual
   rotation.

No migration changes prior `/upload`, `/file/*`, dashboard media storage,
legacy `/api/manage`, `/api/db/*`, `/api/projects/*`, or `/api/storage/*`
authorization behavior. The latter remains Developer-Bearer-key based and is
not an S3 credential route.

---

## 7. Verification coverage and remaining boundary

Focused tests cover credential creation/listing/revocation/rotation,
no-plaintext KV persistence, missing-pepper fail-closed behavior, direct lookup
without list scans, metadata verifier tampering, dashboard-only management,
project/scope isolation, an AWS published SigV4 HMAC fixture, canonical
URI/query/header cases, Web Crypto final verification invocation, alternate
ports, malformed/duplicate Authorization and `x-amz-*` headers, wrong
region/service/scope date, past/future skew, `UNSIGNED-PAYLOAD`, unsupported
content encoding, presigned-style controls, method/URI/signature/header/query,
and one-byte body/payload-hash tampering. Route coverage exercises signed
PUT/GET/List/HEAD/DELETE and legacy protocol behavior remains under the
existing test suite.

The security boundary is intentionally narrow: Cloudflare Pages/Workers,
TLS, Cloudflare KV, the configured secret bindings, and the Telegram Bot API
remain trusted deployment dependencies. KV/object control state is repairable
and eventually consistent rather than transactional. A valid signature proves
control of a credential in the small skew window; it does not provide a
network-wide anti-replay guarantee, legal/audit identity, unlimited object
performance, or AWS service equivalence.
