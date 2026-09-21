import { DATA_PLANE } from './openapi.js';
import { API_KEY_SCOPES } from './developer-api-keys.js';
import { JWT_AUDIENCE, JWT_ISSUER_ENV, JWT_TTL } from './jwt-auth.js';
import { S3_SIGV4_REGION, S3_SIGV4_SERVICE } from './s3-sigv4.js';
import { CLOUD_LIMITS } from './validation.js';

// Single source for the developer documentation surface: the human-readable
// pages under /docs, /llms.txt, /llms-full.txt, the copy-ready AI-agent
// onboarding text, and /.well-known/telegraph.json. Everything derived here
// is generated from the same constants the implementation uses (route
// catalog, scopes, TTLs, limits), so the documentation cannot silently drift
// from the real API. No secret values may ever appear in this module — only
// environment variable NAMES and credential PREFIXES with placeholders.

export const SERVICE_NAME = 'Telegraph Cloud';

const DOC_BYTES_96KIB = CLOUD_LIMITS.DEFAULT_DOCUMENT_DATABASE_MAX_BYTES;
const DOC_BYTES_20MIB = CLOUD_LIMITS.MAX_OBJECT_BYTES;

export const DOC_PAGES = Object.freeze([
  { slug: 'getting-started', title: 'Getting started', description: 'From zero to a first authenticated request.' },
  { slug: 'projects', title: 'Projects', description: 'The isolation boundary every credential and record belongs to.' },
  { slug: 'collections', title: 'Collections', description: 'Names, schemas, and enforcement.' },
  { slug: 'crud', title: 'Documents & CRUD', description: 'Versioned records, preconditions, idempotency, queries.' },
  { slug: 'api-keys', title: 'API keys', description: 'tg_live_… Bearer credentials and scopes.' },
  { slug: 'jwt', title: 'JWT (short-lived tokens)', description: 'Exchange a credential for an ES256 token.' },
  { slug: 'jwks', title: 'JWKS (public keys)', description: 'Verify tokens against /.well-known/jwks.json.' },
  { slug: 'storage', title: 'Object storage', description: 'Buckets, ranges, conditions, listing.' },
  { slug: 's3', title: 'S3-compatible endpoint', description: 'SigV4 GetObject/PutObject/ListObjectsV2 and friends.' },
  { slug: 'ai', title: 'AI agents', description: 'Direct integration instructions for coding agents.' },
  { slug: 'self-hosting', title: 'Self-hosting', description: 'Bindings, deployment, and operational honesty.' },
]);

// ---------------------------------------------------------------------------
// Endpoint table shared by every surface. Derived from the OpenAPI catalog so
// the developer data plane is described identically everywhere. Auth routes
// and the operator rotation route are appended explicitly (they are not
// developer data-plane CRUD but belong in an integration guide).
// ---------------------------------------------------------------------------

const DATA_PLANE_DESCRIPTIONS = {
  '/api/db/{collection}': 'List documents in a collection / create a document.',
  '/api/db/{collection}/{recordId}': 'Read, update (preconditioned), or delete one document.',
  '/api/storage/{bucket}': 'List objects (prefix, delimiter, cursor).',
  '/api/storage/{bucket}/{key}': 'Upload, download (ranges/conditions), head, or delete an object.',
  '/s3/{bucket}': 'S3 ListObjectsV2 (SigV4).',
  '/s3/{bucket}/{key}': 'S3 GetObject / HeadObject / PutObject / DeleteObject (SigV4).',
  '/api/auth/token': 'Exchange a developer credential for a short-lived ES256 JWT.',
  '/.well-known/jwks.json': 'Public JWT verification keys (public members only).',
  '/api/health': 'Deployment health signal.',
  '/openapi.json': 'Machine-readable OpenAPI 3.1 description.',
};

const AUTH_ROUTE_AUTH = {
  '/api/auth/token': 'Bearer (key or unexpired JWT)',
  '/.well-known/jwks.json': 'Public',
  '/api/health': 'Public',
  '/openapi.json': 'Public',
};

function methodAuth(path, method) {
  if (AUTH_ROUTE_AUTH[path]) return AUTH_ROUTE_AUTH[path];
  if (path.startsWith('/s3/')) return 'SigV4 (tgsk_live_… credentials)';
  const write = ['post', 'patch', 'delete', 'put'].includes(method);
  return `Bearer · ${write ? (path.startsWith('/api/storage') ? 'storage:write' : 'db:write') : (path.startsWith('/api/storage') ? 'storage:read' : 'db:read')}`;
}

export function endpointRows() {
  const rows = [];
  for (const route of DATA_PLANE) {
    for (const method of route.methods) {
      rows.push({
        method: method.toUpperCase(),
        path: route.path,
        auth: methodAuth(route.path, method),
        description: DATA_PLANE_DESCRIPTIONS[route.path] || '',
      });
    }
  }
  // Operator surface: dashboard-session gated, documented for completeness.
  rows.push({ method: 'POST', path: '/api/auth/keys/rotate', auth: 'Dashboard session', description: 'Rotate JWT signing keys; outstanding tokens keep verifying until they expire.' });
  return rows;
}

// ---------------------------------------------------------------------------
// Minimal markdown rendering for the HTML /docs pages. The markdown subset is
// exactly what this module authors: fenced code blocks, headings, bullet
// lists, pipe tables, paragraphs, `code`, **bold**, and [links](url).
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, strong) => `<strong>${strong}</strong>`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!/^(https?:\/\/|\/|#)/.test(href)) return match;
    return `<a href="${href}">${label}</a>`;
  });
  return out;
}

function headingId(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function markdownToHtml(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let paragraph = [];
  let inCode = false;
  let codeBuffer = [];
  let listBuffer = [];
  let tableBuffer = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listBuffer.length) {
      out.push(`<ul>${listBuffer.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
      listBuffer = [];
    }
  };
  const flushTable = () => {
    if (!tableBuffer.length) return;
    const rows = tableBuffer
      .map((row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
    const [header, , ...body] = rows;
    const head = `<tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr>`;
    const rowsHtml = body
      .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`)
      .join('');
    out.push(`<table><thead>${head}</thead><tbody>${rowsHtml}</tbody></table>`);
    tableBuffer = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (inCode) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        codeBuffer.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      inCode = true;
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      flushAll();
      const level = line.match(/^#+/)[0].length + 1;
      const text = line.replace(/^#+ /, '');
      out.push(`<h${level} id="${headingId(text)}">${inlineMarkdown(text)}</h${level}>`);
      continue;
    }
    if (/^- /.test(line)) {
      flushParagraph();
      flushTable();
      listBuffer.push(line.slice(2));
      continue;
    }
    if (/^\|/.test(line)) {
      flushParagraph();
      flushList();
      tableBuffer.push(line);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    flushTable();
    paragraph.push(line.trim());
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Page content (markdown). Facts are interpolated from implementation
// constants so the text cannot drift from the code.
// ---------------------------------------------------------------------------

function endpointTableMarkdown() {
  const rows = endpointRows()
    .map((row) => `| \`${row.method}\` | \`${row.path}\` | ${row.auth} | ${row.description} |`);
  return [
    '| Method | Path | Authentication | Description |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function errorTableMarkdown() {
  return [
    '| Status | Error codes | Meaning |',
    '| --- | --- | --- |',
    '| 400 | `invalid_json`, `invalid_query_filter`, `invalid_expected_version`, `invalid_token_request`, `invalid_token_ttl`, `invalid_jwt_issuer` | Malformed request or out-of-range parameter. |',
    '| 401 | `unauthenticated`, `invalid_api_key`, `invalid_token`, `token_expired` | Missing or rejected credential (expired tokens say `token_expired`). |',
    '| 403 | `api_key_scope_forbidden` | The credential is valid but lacks the required scope. |',
    '| 404 | `collection_not_found`, `record_not_found`, `object_not_found`, `bucket_not_found` | The addressed resource does not exist. |',
    '| 409 | `version_conflict`, `collection_exists` | Optimistic-concurrency failure (body also carries `current_version`) or duplicate collection name. |',
    '| 429 | `rate_limited` | Local mutation burst guard: at most 20 mutating requests per 60 s per project. |',
    '| 500 | `internal_error` | Unexpected failure; safe to retry reads. |',
  ].join('\n');
}

function pageGettingStarted(origin) {
  return `Telegraph Cloud is a self-hosted data and storage platform: **versioned JSON
document collections**, **object storage** (with an S3-compatible endpoint),
and **scoped developer credentials**. It is deliberately **not** a SQL
database — there is no SQL dialect, no wire protocol, and no ORM
compatibility. If your integration needs PostgreSQL semantics, Telegraph
Cloud is the wrong tool; everything else below is a five-minute setup.

## 1. Open the console

All management happens in the **console at \`/console\`** (the canonical
surface). The legacy \`/admin\` path still works and redirects into the
console — bookmarks keep working.

## 2. Create a project and an API key

1. Sign in to \`${origin}/console\` (dashboard Basic credentials).
2. Create a **project** — you receive a project id (\`prj_…\`).
3. Under the project's **API keys**, create a key. The full
   \`tg_live_…\` secret is shown **exactly once** — copy it immediately.

## 3. Configure your environment

Store credentials in a gitignored \`.env\`, never in code, URLs, or
localStorage:

\`\`\`bash
export TELEGRAPH_URL="${origin}"
export TELEGRAPH_PROJECT="prj_xxxxxxxxxxxxxxxx"
export TELEGRAPH_API_KEY="tg_live_YOUR_KEY"
\`\`\`

## 4. Make your first request

Create and read a document (records are versioned; \`data.id\` is
server-assigned):

\`\`\`bash
curl -s -X POST "$TELEGRAPH_URL/api/db/notes" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Hello", "done": false}'

curl -s "$TELEGRAPH_URL/api/db/notes?limit=20" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY"
\`\`\`

Optionally, exchange the long-lived key for a **short-lived JWT** before
touching the data plane:

\`\`\`bash
curl -s -X POST "$TELEGRAPH_URL/api/auth/token" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY"
\`\`\`

## Machine-readable surfaces

- [OpenAPI 3.1](${origin}/openapi.json) — generated from the real route catalog.
- [llms.txt](${origin}/llms.txt) and [llms-full.txt](${origin}/llms-full.txt) — digests for coding agents.
- [telegraph.json](${origin}/.well-known/telegraph.json) — service metadata and capability flags.
- [JWKS](${origin}/.well-known/jwks.json) — public JWT verification keys.

## Honesty first

Errors are \`{"error": "<code>"}\` with stable machine-readable codes.
Not implemented (and documented as such everywhere): SQL, SQL wire
protocols, ORM compatibility, S3 multipart uploads, presigned URLs, and
bucket policies.`;
}

function pageProjects() {
  return `Every record, object, and credential belongs to exactly one **project**.
Projects are the isolation boundary: a credential issued for project A can
never read or write project B.

## Facts

- Project ids look like \`prj_…\` and are **generated by the deployment** —
  never trust a project id supplied by a caller.
- Projects have a URL-safe slug (\`[a-z][a-z0-9-]*\`), a display name, and
  optional collections.
- Project management (create, rename, diagnostics, collection schemas) is a
  **dashboard** capability: sign in at \`/console\` with the deployment's
  Basic credentials. The dashboard session is never a developer credential.
- Developer credentials (API keys, JWTs, S3 credentials) carry their project
  scope **inside the credential**. The API derives the project boundary from
  the verified credential only — a request body or query parameter naming a
  project is ignored for authorization purposes.

## How a project maps to your integration

- One application environment ⇒ one project is the normal shape.
- Use separate projects to separate staging from production data on the same
  deployment; create one key per environment and store each in its own
  \`.env\`.`;
}

function pageCollections() {
  return `Collections are named sets of versioned JSON documents. Every collection
exposes the **same generic CRUD routes** — there is no per-collection code
generation and no schema migration tooling to run.

## Names and creation

- Collection names match \`[a-z][a-z0-9_-]*\` (max ${CLOUD_LIMITS.MAX_COLLECTION_NAME_LENGTH} bytes).
- Collections are created and configured **in the console** (dashboard
  session): name, human description, and an optional **field schema**.
- Writes to a collection name that has never been configured still work;
  the collection then behaves as *legacy/untyped* (no schema enforcement)
  until a schema is defined. Defining a schema later constrains future
  writes and never rewrites stored records.

## Schemas

A schema is a list of fields with types and optional defaults. When a
collection has a schema:

- Created and updated documents are validated against it
  (\`schema_validation_failed\` on violation).
- Declared defaults are applied to creates **before** idempotency
  fingerprinting, so retries and first writes agree.
- At most ${CLOUD_LIMITS.MAX_DOCUMENT_INDEXED_FIELDS} fields are indexed; only indexed top-level string fields can be
  used as exact-match list filters (up to ${CLOUD_LIMITS.MAX_DOCUMENT_QUERY_FILTERS} filters per request).

## Reserved fields

Document bodies keep a few server-managed members: \`id\` (record id,
\`rec_…\`) lives inside \`data\`; \`version\`, \`created_at\`, and
\`updated_at\` are returned as siblings of \`data\`. A client patch never
modifies \`_expected_version\` — it is the precondition field, not data.`;
}

function pageCrud(origin) {
  return `All document operations live under \`/api/db/{collection}\` and accept the
same Bearer credential (API key or short-lived JWT). Writes require the
\`db:write\` scope; reads require \`db:read\`.

## Endpoints

${endpointTableMarkdown()}

## Create

\`\`\`bash
curl -s -X POST "$TELEGRAPH_URL/api/db/notes" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: draft-42" \\
  -d '{"title": "Hello", "done": false}'
\`\`\`

Response — \`201 Created\` (retries with the same \`Idempotency-Key\` and
body return the original result without appending another revision; keys are
at most ${CLOUD_LIMITS.MAX_IDEMPOTENCY_KEY_BYTES} bytes):

\`\`\`json
{
  "data": { "id": "rec_0123456789abcdef01234567", "title": "Hello", "done": false },
  "version": 1,
  "created_at": "2026-09-21T09:00:00.000Z",
  "updated_at": "2026-09-21T09:00:00.000Z"
}
\`\`\`

## Read

- One record: \`GET /api/db/notes/rec_0123456789abcdef01234567\` → \`200\`
  with the shape above (and an \`ETag: "N"\` header).
- List: \`GET /api/db/notes?limit=20&cursor=…&done=false\` →

\`\`\`json
{
  "data": [ { "data": { }, "version": 1, "created_at": "…", "updated_at": "…" } ],
  "order": "id:asc",
  "limit": 20,
  "has_more": false,
  "next_cursor": null
}
\`\`\`

- \`limit\` is 1–${CLOUD_LIMITS.MAX_DOCUMENT_QUERY_LIMIT} (default ${CLOUD_LIMITS.DEFAULT_DOCUMENT_QUERY_LIMIT}); \`cursor\` is the opaque
  \`next_cursor\` from the previous page; exact-match filters are
  \`field=value\` pairs on indexed top-level string fields
  (max ${CLOUD_LIMITS.MAX_DOCUMENT_QUERY_FILTERS} per request).

## Update (optimistic concurrency)

PATCH requires the expected current version — either the documented body
field or the standard header. The two forms must agree:

\`\`\`bash
curl -s -X PATCH "$TELEGRAPH_URL/api/db/notes/rec_0123456789abcdef01234567" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H 'If-Match: "1"' \\
  -d '{"done": true}'
\`\`\`

- Success: \`200\` with the new version.
- Stale version: \`409\` with \`{"error": "version_conflict",
  "current_version": 3}\` — re-read and retry.
- Missing precondition: \`400 invalid_expected_version\`.

## Delete

\`\`\`bash
curl -s -X DELETE "$TELEGRAPH_URL/api/db/notes/rec_0123456789abcdef01234567" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"_expected_version": 2}'
\`\`\`

Returns \`200\` with \`"deleted": true\` and \`deleted_at\`. Revisions are
immutable; deletion is itself a journalled revision.

## Sizes, ordering, and bursts

- Document bodies are bounded (default ceiling ${DOC_BYTES_96KIB} bytes ≈ 96 KiB; depth
  ≤ ${CLOUD_LIMITS.MAX_DOCUMENT_DEPTH}, ≤ ${CLOUD_LIMITS.MAX_DOCUMENT_NODES} nodes). Large payloads belong in object storage —
  store the object, reference its key from the document.
- Lists are ordered by id ascending — pagination is stable.
- Mutations are burst-guarded per project: ${'20'} mutating requests per 60 s
  beyond that return \`429 rate_limited\`. Back off and retry.

## Errors

${errorTableMarkdown()}`;
}

function pageApiKeys() {
  return `Developer API keys (\`tg_live_…\`) are the primary Bearer credential for
the document and object APIs.

## Scopes

| Scope | Grants |
| --- | --- |
| \`db:read\` | \`GET\` on \`/api/db/*\` |
| \`db:write\` | \`POST\` / \`PATCH\` / \`DELETE\` on \`/api/db/*\` |
| \`storage:read\` | \`GET\` / \`HEAD\` / list on \`/api/storage/*\` |
| \`storage:write\` | \`PUT\` / \`DELETE\` on \`/api/storage/*\` |

A key requests its scopes at creation; every request is checked against the
verified key's scopes (\`403 api_key_scope_forbidden\` otherwise). The
project boundary always comes from the key itself.

## Lifecycle rules

- Created in the console (\`/console\`) only. The full secret is shown
  **exactly once** in an acknowledgement dialog — copy it into your
  gitignored \`.env\` immediately.
- List endpoints return **verifier-only metadata**: label, prefix,
  fingerprint, scopes, status, dates. The secret is unrecoverable — rotate
  instead of asking.
- **Rotation** issues a new secret (label/scopes preserved) and revokes the
  old key immediately.
- Keys never belong in URLs, localStorage, logs, analytics, or commits.
  Send them only in the \`Authorization: Bearer\` header.
- Keys are never forwarded upstream (e.g. to Telegram) by the platform.

## Keys are for services, sessions are for humans

The dashboard session unlocks \`/console\` management surfaces. It is a
separate credential kind and is never accepted by the developer data plane.`;
}

function pageJwt(origin) {
  return `For services that should not hold a long-lived key in memory, exchange the
key (or an unexpired JWT) for a **short-lived, asymmetrically signed JWT**
at \`POST /api/auth/token\`.

## Issuing a token

\`\`\`bash
curl -s -X POST "$TELEGRAPH_URL/api/auth/token" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"expires_in": ${JWT_TTL.default}}'
\`\`\`

Response (\`no-store\`; the body is the credential — do not log it):

\`\`\`json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs…",
  "token_type": "Bearer",
  "expires_in": ${JWT_TTL.default},
  "scope": "db:read db:write"
}
\`\`\`

- \`expires_in\` is the **only** accepted body member; default
  ${JWT_TTL.default} s, bounded to ${JWT_TTL.min}–${JWT_TTL.max} s.
- The token **inherits** the presenting credential's project and scopes — a
  token can never exceed the authority used to obtain it. Unknown body
  fields are rejected (\`400 invalid_token_request\`).

## Token shape

Compact JWS, signed **ES256** (ECDSA P-256 + SHA-256). The \`alg\` header is
pinned — verifiers must reject everything else.

| Claim | Meaning |
| --- | --- |
| \`iss\` | Issuer: \`TELEGRAPH_CLOUD_JWT_ISSUER\` if configured, else the deployment origin. |
| \`aud\` | Always \`${JWT_AUDIENCE}\`. |
| \`sub\` | The issuing API-key id. |
| \`project\` | The verified project scope. |
| \`scopes\` | The (scope-filtered) granted scopes. |
| \`iat\`, \`exp\` | Issue time and expiry (Unix seconds; 30 s leeway). |
| \`jti\` | Unique token id. |
| header \`kid\` | Signing key id — resolve it in the JWKS. |

Use the token exactly like a key:
\`Authorization: Bearer <access_token>\` on any developer route.

## Failure codes

- \`401 token_expired\` — expired; fetch a new one.
- \`401 invalid_token\` — malformed, bad signature, unknown \`kid\`, wrong
  issuer/audience, or bad claims.
- \`400 invalid_jwt_issuer\` / \`400 invalid_token_ttl\` /
  \`400 invalid_token_request\` — misconfiguration or out-of-bounds input.

## Operational notes

- Tokens are ≤ 16 KB and \`no-store\`; treat them like secrets (memory only,
  never URLs or localStorage).
- Rotation (see [JWKS](#jwks-public-keys)) never invalidates outstanding
  tokens — old tokens keep verifying against the retired public key until
  they expire naturally.`;
}

function pageJwks(origin) {
  return `Public verification keys for JWTs are published at
\`GET /.well-known/jwks.json\` — publicly readable and cacheable for
5 minutes (\`Cache-Control: public, max-age=300\`).

\`\`\`bash
curl -s "$TELEGRAPH_URL/.well-known/jwks.json"
\`\`\`

\`\`\`json
{
  "keys": [
    {
      "kty": "EC", "crv": "P-256",
      "x": "…", "y": "…",
      "kid": "kid_000001",
      "alg": "ES256", "use": "sig", "key_ops": ["verify"]
    }
  ]
}
\`\`\`

## Guarantees

- **Public members only.** The private scalar (\`d\`) is never published —
  private keys live only in the deployment's KV and are purged on rotation.
- **Rotation-aware.** During a rotation window the set contains both the
  current and the retired key, so outstanding tokens keep verifying until
  expiry. Verify by \`kid\`, never by position.
- Rotation is an operator action: \`POST /api/auth/keys/rotate\`, gated by
  the dashboard session (fails closed with
  \`503 dashboard_auth_not_configured\` when dashboard auth is unset). The
  response carries \`{rotated, current_kid, retired_kid}\` and no key
  material.

## Verifying a token (Python, PyJWT)

\`\`\`python
import jwt  # PyJWT
from jwt import PyJWKClient

jwks_client = PyJWKClient("$TELEGRAPH_URL/.well-known/jwks.json")
signing_key = jwks_client.get_signing_key_from_jwt(token)
claims = jwt.decode(
    token,
    signing_key.key,
    algorithms=["ES256"],            # pinned — reject everything else
    audience="${JWT_AUDIENCE}",
    issuer="$TELEGRAPH_URL",          # or the configured issuer
)
\`\`\`

After \`401 token_expired\`, exchange the API key for a fresh token via
\`POST /api/auth/token\`.`;
}

function pageStorage(origin) {
  return `Object storage is the same engine behind Drive, \`/api/storage\`, and the
S3 endpoint — one manifest, one bytes store.

## Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| \`PUT\` | \`/api/storage/{bucket}/{key}\` | \`storage:write\` | Upload an object (≤ ${DOC_BYTES_20MIB} bytes). |
| \`GET\` | \`/api/storage/{bucket}/{key}\` | \`storage:read\` | Download bytes; \`Range\` supported. |
| \`HEAD\` | \`/api/storage/{bucket}/{key}\` | \`storage:read\` | Metadata without the body. |
| \`DELETE\` | \`/api/storage/{bucket}/{key}\` | \`storage:write\` | Delete an object. |
| \`GET\` | \`/api/storage/{bucket}\` | \`storage:read\` | List objects (prefix/delimiter/cursor). |

- Bucket names: ${CLOUD_LIMITS.MIN_BUCKET_NAME_LENGTH}–${CLOUD_LIMITS.MAX_BUCKET_NAME_LENGTH} characters. Object keys: ≤ ${CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES} bytes.
- Custom metadata: send \`x-amz-meta-<name>\` headers on PUT (≤ ${CLOUD_LIMITS.MAX_CUSTOM_METADATA_ENTRIES} entries);
  they round-trip on GET/HEAD.

## Upload

\`\`\`bash
curl -s -X PUT "$TELEGRAPH_URL/api/storage/media/photos/bean.jpg" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: image/jpeg" \\
  --data-binary @bean.jpg
\`\`\`

\`200\` with \`{"data": {bucket, key, size, content_type, etag, version,
created_at, updated_at}}\`.

## Download (ranges and conditions)

- \`Range: bytes=0-1023\` → \`206 Partial Content\` with \`Content-Range\`.
- \`If-Match: "N"\` / \`If-None-Match: "N"\` → preconditioned reads
  (\`304 Not Modified\` / \`412 Precondition Failed\`).
- Responses carry \`ETag\`, \`Last-Modified\`,
  \`X-Telegraph-Cloud-Object-Version\`, and \`Accept-Ranges: bytes\`.

## List

\`\`\`bash
curl -s "$TELEGRAPH_URL/api/storage/media?prefix=photos/&delimiter=/&limit=50" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY"
\`\`\`

→ \`{"data": [...], "common_prefixes": [...], "has_more": false,
"next_cursor": null}\`. \`limit\` is ≤ ${CLOUD_LIMITS.MAX_OBJECT_LIST_LIMIT} (default ${CLOUD_LIMITS.DEFAULT_OBJECT_LIST_LIMIT}); page with
\`cursor\`.

Errors use the shared \`{"error": code}\` envelope
(\`object_not_found\`, \`bucket_not_found\`, \`rate_limited\`, …).`;
}

function pageS3(origin) {
  return `The \`/s3\` endpoint speaks **AWS Signature Version 4** (header form) for
tooling that already speaks S3. It is deliberately scoped:

**Implemented**: GetObject, HeadObject, PutObject, DeleteObject,
ListObjectsV2 — path-style addressing, fixed region
\`${S3_SIGV4_REGION}\`, service \`${S3_SIGV4_SERVICE}\`.

**Not implemented** (documented honestly): multipart uploads, presigned
URLs, bucket policies.

## Credentials

S3 uses its own credential kind — \`tgsk_live_…\` access key id plus secret
access key, created in the console with \`s3:read\`/\`s3:write\` scopes.
They are separate from \`tg_live_…\` Bearer keys and never interchangeable.

## AWS CLI

\`\`\`bash
export AWS_ACCESS_KEY_ID="tgsk_live_YOUR_KEY_ID"
export AWS_SECRET_ACCESS_KEY="YOUR_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${S3_SIGV4_REGION}"

aws s3api put-object \\
  --endpoint-url "$TELEGRAPH_URL/s3" \\
  --bucket media --key photos/bean.jpg \\
  --body ./bean.jpg

aws s3api list-objects-v2 \\
  --endpoint-url "$TELEGRAPH_URL/s3" --bucket media --prefix photos/
\`\`\`

The same objects are visible through \`/api/storage\` and Drive — buckets
and keys are identical across all three surfaces.

## Signature details

- Only the \`Authorization\` header form (\`AWS4-HMAC-SHA256 …\`) is
  accepted; signed requests are time-bound (bounded clock skew).
- Region must be \`${S3_SIGV4_REGION}\` and service \`${S3_SIGV4_SERVICE}\`
  in the credential scope.`;
}

function pageAi(origin) {
  return `This page is written for **coding agents** and their operators. It is the
human-readable twin of \`/llms.txt\`; everything here is generated from the
same catalog as the OpenAPI document, so it matches the real API.

## Direct integration instructions

1. **Read before writing code.** Fetch [llms.txt](${origin}/llms.txt), then
   [llms-full.txt](${origin}/llms-full.txt) and
   [openapi.json](${origin}/openapi.json). These are generated from the deployment's
   real routes — there are no other endpoints.
2. **Inspect the existing repository** before adding anything. If a
   Telegraph Cloud integration already exists, **reuse and extend it**;
   never fork it into a second client.
3. **Credentials**: create a project and an API key in
   [the console](${origin}/console) (\`tg_live_…\`, shown exactly once). Put names
   in code and values in a gitignored \`.env\`:
   \`TELEGRAPH_URL\`, \`TELEGRAPH_PROJECT\`, \`TELEGRAPH_API_KEY\`
   (plus \`AWS_ACCESS_KEY_ID\` / \`AWS_SECRET_ACCESS_KEY\` for S3). Never
   commit secrets; never put them in URLs or localStorage.
4. **First request** — prove access before building:

\`\`\`bash
curl -s -X POST "$TELEGRAPH_URL/api/db/notes" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" -d '{"ok": true}'
\`\`\`

5. **Prefer short-lived tokens** for long-running services: exchange the key
   at \`POST /api/auth/token\` (≤ ${JWT_TTL.max} s) and verify against
   [/.well-known/jwks.json](${origin}/.well-known/jwks.json).
6. **Use the generic CRUD routes** for every collection — do not generate
   per-collection clients. Documents are versioned; sends
   \`_expected_version\` / \`If-Match\` on writes and handle
   \`409 version_conflict\`.
7. **Capabilities**: document CRUD, object storage, S3-compatible
   GetObject/PutObject/HeadObject/DeleteObject/ListObjectsV2. **Not
   available** (do not pretend otherwise): SQL, psql/wire protocols,
   PostgreSQL/Prisma/Drizzle compatibility, S3 multipart, presigned URLs,
   bucket policies.
8. **Do not create another database.** Telegraph Cloud is the data layer for
   this deployment; introducing PostgreSQL, SQLite, or an ORM beside it is a
   blocked pattern.
9. **On errors**, read the stable \`{"error": code}\` body and the
   [documents & CRUD](#documents-crud) table — retry only what is safe
   (reads; idempotent creates with \`Idempotency-Key\`).

## Copy-ready onboarding

\`${origin}/docs/ai-agent\` returns a plain-text onboarding brief with the
same instructions, rooted at the current origin — paste it into an agent's
context (` + '`AGENTS.md`' + `, \`CLAUDE.md\`, \`.cursor/rules\`, …).`;
}

function pageSelfHosting(origin) {
  return `Telegraph Cloud is a Cloudflare Pages deployment: static assets plus
\`functions/\` directory routing. No build step, no containers.

## Run locally

\`\`\`bash
npm ci
npm run start:cloud     # wrangler pages dev on 0.0.0.0:8080, persisted to ./data
\`\`\`

## Deploy

\`\`\`bash
npx wrangler pages deploy ./
\`\`\`

Set bindings in the Cloudflare Pages project settings (or CI secrets) —
never in the repository.

## Bindings

| Binding | Kind | Required | Purpose |
| --- | --- | --- | --- |
| \`TELEGRAPH_CLOUD_KV\` | KV namespace | yes | Cloud index: projects, keys, signing keys, metadata. |
| \`TG_Bot_Token\`, \`TG_Chat_ID\` | vars | for Telegram-backed storage | Journal/object pointers via the Telegram Bot API. |
| \`STORAGE_PROVIDER\` | var | optional | \`r2\` switches object storage to an R2 bucket binding. |
| \`API_KEY_PEPPER\` | secret | yes | HMAC pepper for \`tg_live_…\` key verification (≥ 32 random bytes). Changing it invalidates existing developer keys. |
| \`TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER\` | secret | for /s3 | HMAC pepper for SigV4 credential verification (≥ 32 random bytes). |
| \`BASIC_USER\`, \`BASIC_PASS\` | vars | yes | Dashboard sign-in for \`/console\` and the dashboard-legacy database mode. |
| \`TELEGRAPH_CLOUD_JWT_ISSUER\` | var | optional | Override the JWT \`iss\` (default: deployment origin). |
| \`TELEGRAPH_CLOUD_S3_ENDPOINT_HOST\` | var | optional | Alternate /s3 endpoint host. |

Peppers and Basic credentials are **secrets**: generate them
(\`openssl rand -base64 32\`), store them only in platform configuration,
and never commit or log them. Rotate the JWT issuer freely — tokens carry
\`iss\` and old tokens simply fail verification.

## Compatibility notes

- \`/console\` is the canonical management surface; \`/admin\` remains a
  compatibility entry that redirects into the console. The legacy media
  workspace stays available at \`/admin.html\` with its contracts unchanged.
- Existing upload/albums APIs and data formats are preserved across
  upgrades; new phases add, they do not remove.
- Health: \`GET /api/health\` reports \`ok\`/\`degraded\` (degraded typically
  means the Telegram journal is not configured in this environment).

## What this deployment deliberately is not

No SQL engine, no SQL wire protocol, no ORM adapters, no S3 multipart /
presigned URLs / bucket policies, no distributed rate limiting (the burst
guard is per-isolate). Every one of these is documented as a non-goal
rather than silently missing.`;
}

const DOC_CONTENT = {
  'getting-started': pageGettingStarted,
  projects: () => pageProjects(),
  collections: () => pageCollections(),
  crud: (origin) => pageCrud(origin),
  'api-keys': () => pageApiKeys(),
  jwt: (origin) => pageJwt(origin),
  jwks: (origin) => pageJwks(origin),
  storage: (origin) => pageStorage(origin),
  s3: (origin) => pageS3(origin),
  ai: (origin) => pageAi(origin),
  'self-hosting': (origin) => pageSelfHosting(origin),
};

export function docPage(slug) {
  return DOC_PAGES.find((page) => page.slug === slug) || null;
}

export function docMarkdown(slug, { origin }) {
  const render = DOC_CONTENT[slug];
  return render ? render(origin) : null;
}

// ---------------------------------------------------------------------------
// HTML shell for /docs pages.
// ---------------------------------------------------------------------------

const DOCS_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         line-height: 1.6; background: #f6f7f9; color: #1c2733; }
  a { color: #0b62d6; }
  header { border-bottom: 1px solid #d9dee5; background: #ffffff; }
  header .inner, nav .inner, main, footer .inner { max-width: 980px; margin: 0 auto; padding: 0 20px; }
  header .inner { display: flex; align-items: baseline; gap: 14px; padding-top: 18px; padding-bottom: 18px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header h1 a { color: inherit; text-decoration: none; }
  header .tag { color: #5b6673; font-size: 13px; }
  nav { background: #ffffff; border-bottom: 1px solid #d9dee5; overflow-x: auto; }
  nav .inner { display: flex; gap: 4px; padding-top: 6px; padding-bottom: 6px; flex-wrap: wrap; }
  nav a { color: #40506a; text-decoration: none; font-size: 13.5px; padding: 5px 10px; border-radius: 6px; white-space: nowrap; }
  nav a[aria-current="page"] { background: #e8f0fe; color: #0b62d6; font-weight: 600; }
  main { padding: 26px 20px 60px; }
  main article { max-width: 76ch; }
  h2 { font-size: 26px; margin: 8px 0 4px; }
  h3 { font-size: 18px; margin-top: 30px; }
  h4 { font-size: 15.5px; margin-top: 24px; }
  pre { background: #10212f; color: #e8eef4; padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.55; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  p code, li code, td code, th code { background: #eceff3; border: 1px solid #dde2e9; border-radius: 4px; padding: 0 4px; }
  pre code { background: transparent; border: 0; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
  th, td { border: 1px solid #d9dee5; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #eef1f5; }
  footer { border-top: 1px solid #d9dee5; color: #5b6673; font-size: 13px; }
  footer .inner { padding-top: 16px; padding-bottom: 26px; }
  @media (prefers-color-scheme: dark) {
    body { background: #10161d; color: #dbe4ec; }
    header, nav { background: #151d26; border-color: #263140; }
    header .tag, footer { color: #93a1b0; }
    nav a { color: #b9c5d2; }
    nav a[aria-current="page"] { background: #1b3a5c; color: #8fc1ff; }
    a { color: #6db2ff; }
    pre { background: #0a1219; }
    p code, li code, td code, th code { background: #1a232d; border-color: #2c3946; }
    th { background: #1a232d; }
    th, td { border-color: #2c3946; }
  }`;

function docsHtml({ title, description, activeSlug, origin, bodyHtml }) {
  const nav = DOC_PAGES
    .map((page) => `<a href="/docs/${page.slug}"${page.slug === activeSlug ? ' aria-current="page"' : ''}>${escapeHtml(page.title)}</a>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(SERVICE_NAME)}</title>
<meta name="description" content="${escapeHtml(description)}">
<style>${DOCS_STYLE}</style>
</head>
<body>
<header><div class="inner">
<h1><a href="/docs">Telegraph Cloud docs</a></h1>
<span class="tag">developer documentation · <a href="${origin}/console">console</a></span>
</div></header>
<nav><div class="inner">${nav}</div></nav>
<main><article>
${bodyHtml}
</article></main>
<footer><div class="inner">
Generated from the real route catalog — <a href="${origin}/openapi.json">OpenAPI</a> ·
<a href="${origin}/llms.txt">llms.txt</a> ·
<a href="${origin}/llms-full.txt">llms-full.txt</a> ·
<a href="${origin}/.well-known/telegraph.json">telegraph.json</a> ·
<a href="${origin}/.well-known/jwks.json">jwks.json</a>
</div></footer>
</body>
</html>`;
}

export function renderDocsPage(slug, { origin } = {}) {
  const page = docPage(slug);
  if (!page) return null;
  const markdown = docMarkdown(slug, { origin });
  return docsHtml({
    title: page.title,
    description: page.description,
    activeSlug: page.slug,
    origin,
    bodyHtml: markdownToHtml(markdown),
  });
}

// ---------------------------------------------------------------------------
// /.well-known/telegraph.json — service metadata and capability flags.
// ---------------------------------------------------------------------------

export function telegraphServiceDocument({ origin }) {
  return Object.freeze({
    schema: 'telegraph-cloud.service.v1',
    name: SERVICE_NAME,
    description: 'Self-hosted data and storage platform: versioned JSON document collections, object storage with an S3-compatible endpoint, and scoped developer credentials with optional short-lived JWTs.',
    console: `${origin}/console`,
    compatibility: {
      admin_entry: `${origin}/admin`,
      admin_redirects_to_console: true,
    },
    endpoints: {
      openapi: `${origin}/openapi.json`,
      jwks: `${origin}/.well-known/jwks.json`,
      service_metadata: `${origin}/.well-known/telegraph.json`,
      docs: `${origin}/docs`,
      ai_docs: `${origin}/docs/ai`,
      ai_agent_onboarding: `${origin}/docs/ai-agent`,
      llms: `${origin}/llms.txt`,
      llms_full: `${origin}/llms-full.txt`,
    },
    auth: {
      bearer: {
        header: 'Authorization',
        credentials: 'tg_live_… developer API key or short-lived ES256 JWT',
        scopes: [...API_KEY_SCOPES],
        token_endpoint: `${origin}/api/auth/token`,
        jwt: {
          algorithm: 'ES256',
          audience: JWT_AUDIENCE,
          ttl_default_seconds: JWT_TTL.default,
          ttl_min_seconds: JWT_TTL.min,
          ttl_max_seconds: JWT_TTL.max,
          issuer_env: JWT_ISSUER_ENV,
          issuer_default: origin,
          jwks: `${origin}/.well-known/jwks.json`,
          rotation_endpoint: `${origin}/api/auth/keys/rotate`,
          rotation_auth: 'dashboard session',
        },
      },
      s3: {
        scheme: 'AWS Signature Version 4 (header form)',
        region: S3_SIGV4_REGION,
        service: S3_SIGV4_SERVICE,
        access_key_prefix: 'tgsk_live_…',
        endpoint: `${origin}/s3`,
      },
    },
    capabilities: {
      document_database: true,
      object_storage: true,
      s3_endpoint: true,
      jwt_authentication: true,
      openapi: true,
      sql: false,
      sql_wire_protocol: false,
      orm_compatibility: false,
      s3_multipart_upload: false,
      s3_presigned_urls: false,
      s3_bucket_policies: false,
    },
    limits: {
      document_bytes: DOC_BYTES_96KIB,
      object_bytes: DOC_BYTES_20MIB,
      object_list_default: CLOUD_LIMITS.DEFAULT_OBJECT_LIST_LIMIT,
      object_list_max: CLOUD_LIMITS.MAX_OBJECT_LIST_LIMIT,
      document_query_default: CLOUD_LIMITS.DEFAULT_DOCUMENT_QUERY_LIMIT,
      document_query_max: CLOUD_LIMITS.MAX_DOCUMENT_QUERY_LIMIT,
      mutations_per_minute_per_project: 20,
    },
  });
}

// ---------------------------------------------------------------------------
// llms.txt (concise) and llms-full.txt (complete) — plain-text digests for
// coding agents, rooted at the requesting origin.
// ---------------------------------------------------------------------------

function llmsHeader(origin) {
  return [
    `# ${SERVICE_NAME}`,
    '',
    `> Self-hosted data and storage platform: versioned JSON document collections, object storage with an S3-compatible endpoint (SigV4), and scoped developer credentials (\`tg_live_…\`) with optional short-lived ES256 JWTs. Deliberately NOT a SQL database — no SQL dialect, no wire protocol, no ORM compatibility.`,
    '',
    `Base URL: ${origin}`,
    '',
  ];
}

function llmsAuthSection(origin) {
  return [
    '## Authentication',
    '',
    '- Bearer developer API keys: `Authorization: Bearer tg_live_…` with scopes `db:read`, `db:write`, `storage:read`, `storage:write`. The key determines the project boundary; caller-supplied project ids are never trusted.',
    `- Short-lived JWTs: POST \`/api/auth/token\` with the key (or an unexpired JWT) returns an ES256 token (default ${JWT_TTL.default} s, ${JWT_TTL.min}–${JWT_TTL.max} s) inheriting the credential's project and scopes. Claims: iss, aud (\`${JWT_AUDIENCE}\`), sub, project, scopes, iat, exp, jti; header kid. Verify against \`/.well-known/jwks.json\` (public keys only, rotation-aware).`,
    '- S3 endpoint: AWS Signature Version 4 header form, region `us-east-1`, service `s3`, path-style, separate `tgsk_live_…` credentials.',
    '- The dashboard session (Basic) unlocks `/console` only — it is never a developer credential.',
    '',
    '## Endpoints',
    '',
    ...endpointRows().map((row) => `- \`${row.method} ${row.path}\` — ${row.auth} — ${row.description}`),
    '',
    '## Rules',
    '',
    '- Every collection uses the same generic CRUD routes; records are versioned and writes need the expected version (`If-Match` or `_expected_version`); conflicts return `409 {"error": "version_conflict", "current_version": N}`.',
    '- Retries: send an `Idempotency-Key` header on creates. Mutations are burst-guarded (20 per 60 s per project, then `429 rate_limited`).',
    '- Errors: `{"error": "<stable code>"}`. Read the code, retry only what is safe.',
    '- Limits: document bodies ≤ ~96 KiB, objects ≤ 20 MiB, list/query limits default 20–50 (max 100). Large payloads belong in object storage; reference keys from documents.',
    '- Not implemented (do not pretend otherwise): SQL, SQL wire protocols, PostgreSQL/Prisma/Drizzle compatibility, S3 multipart uploads, presigned URLs, bucket policies.',
    '- Secrets: never in URLs, localStorage, logs, or commits. Keys are created in `/console` and shown exactly once.',
    '',
  ];
}

function llmsLinksSection(origin) {
  return [
    '## Optional',
    '',
    `- [OpenAPI 3.1](${origin}/openapi.json): complete machine-readable API description generated from the real routes.`,
    `- [Full documentation for agents](${origin}/llms-full.txt): every topic below in one plain-text document.`,
    `- [Human documentation](${origin}/docs): getting started, projects, collections, CRUD, API keys, JWT, JWKS, storage, S3, AI agents, self-hosting.`,
    `- [AI agent guide](${origin}/docs/ai): direct integration instructions for coding agents (human + machine readable).`,
    `- [Copy-ready agent brief](${origin}/docs/ai-agent): plain-text onboarding note to paste into an agent's context.`,
    `- [Service metadata](${origin}/.well-known/telegraph.json): endpoints, auth, capabilities, limits as JSON.`,
    `- [JWKS](${origin}/.well-known/jwks.json): public JWT verification keys.`,
    `- [Console](${origin}/console): canonical management surface (\`/admin\` redirects here).`,
    '',
  ];
}

export function llmsDigest({ origin }) {
  return [
    ...llmsHeader(origin),
    '## Getting started',
    '',
    `1. Sign in to ${origin}/console and create a project (id looks like \`prj_…\`).`,
    '2. Create a developer API key — the `tg_live_…` secret is shown exactly once; store it in a gitignored `.env`.',
    '3. Export `TELEGRAPH_URL`, `TELEGRAPH_PROJECT`, `TELEGRAPH_API_KEY`.',
    '',
    '```bash',
    'curl -s -X POST "$TELEGRAPH_URL/api/db/notes" \\',
    '  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\',
    '  -H "Content-Type: application/json" -d \'{"ok": true}\'',
    '',
    'curl -s "$TELEGRAPH_URL/api/db/notes?limit=20" \\',
    '  -H "Authorization: Bearer $TELEGRAPH_API_KEY"',
    '```',
    '',
    ...llmsAuthSection(origin),
    ...llmsLinksSection(origin),
  ].join('\n');
}

export function llmsFull({ origin }) {
  const sections = DOC_PAGES.map((page) => [
    `# ${page.title}`,
    '',
    docMarkdown(page.slug, { origin }),
    '',
    '---',
    '',
  ]);
  return [
    ...llmsHeader(origin),
    ...llmsAuthSection(origin),
    ...llmsLinksSection(origin),
    '# Full documentation',
    '',
    ...sections.flat(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /docs/ai-agent — copy-ready plain-text onboarding brief for coding agents.
// ---------------------------------------------------------------------------

export function aiAgentOnboardingText({ origin }) {
  return `# Integrating with Telegraph Cloud at ${origin}

You are connecting an application to this Telegraph Cloud deployment. Follow
these instructions in order; they are generated from the deployment's real
route catalog, so every endpoint below exists.

## 1. Required reading (fetch before writing code)

- ${origin}/llms.txt — concise digest: endpoints, auth, rules, limits
- ${origin}/llms-full.txt — full documentation for every topic
- ${origin}/openapi.json — OpenAPI 3.1 description of the real surface
- ${origin}/.well-known/telegraph.json — capability flags (note the "false" entries)

## 2. Environment

Create the project and key in the console at ${origin}/console (human step):
the API key secret (tg_live_…) is shown exactly once. Then configure the
application environment — names in code, values only in a gitignored .env:

TELEGRAPH_URL=${origin}
TELEGRAPH_PROJECT=prj_xxxxxxxxxxxxxxxx
TELEGRAPH_API_KEY=tg_live_YOUR_KEY

Never commit secrets. Never put them in URLs, localStorage, or logs. For the
S3 endpoint use separate tgsk_live_… credentials in AWS_ACCESS_KEY_ID /
AWS_SECRET_ACCESS_KEY.

## 3. First request (prove access before building)

curl -s -X POST "$TELEGRAPH_URL/api/db/notes" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\
  -H "Content-Type: application/json" -d '{"ok": true}'

curl -s "$TELEGRAPH_URL/api/db/notes?limit=20" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY"

## 4. Short-lived tokens for services

Exchange the key for an ES256 JWT (default ${JWT_TTL.default} s, max ${JWT_TTL.max} s) and verify it
against ${origin}/.well-known/jwks.json (algorithms pinned to ["ES256"],
audience "${JWT_AUDIENCE}"):

curl -s -X POST "$TELEGRAPH_URL/api/auth/token" \\
  -H "Authorization: Bearer $TELEGRAPH_API_KEY"

## 5. Mandates

1. Read the documentation (step 1) before writing integration code.
2. Inspect the existing repository before adding anything.
3. Reuse the existing integration; extend it, never fork or duplicate it.
4. Do not create another database — Telegraph Cloud is the data layer.
5. Do not introduce PostgreSQL, Prisma, Drizzle, or any SQL/ORM layer:
   this platform has no SQL dialect and no wire protocol.
6. Never commit secrets: credentials live only in the gitignored .env,
   read at runtime.

## 6. Behavior notes

- Documents are versioned: send _expected_version (body) or If-Match
  (header) on PATCH/DELETE and handle 409 version_conflict by re-reading.
- Creates are idempotent with an Idempotency-Key header.
- Collections share the same generic CRUD routes — do not generate
  per-collection clients.
- Errors are {"error": "<code>"}; retry only reads and idempotent writes.
- Mutations are burst-guarded per project (20/60 s, then 429 rate_limited).
`;
}
