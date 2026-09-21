# Telegraph Cloud Console (Phase 7)

The Cloud Console is a second, read/write web UI for Telegraph Cloud. It joins
the established Telegram-backed data plane (document journal + object engine +
S3 adapter, Phases 1–6C) to a cloud-product-style console; it does **not**
replace the object engine, the journal, or the legacy `/admin` workspace, and
it introduces no SQL database.

- Entry point: `/console` (served from `console.html`; bare `/console.html`
  redirects to the canonical `/console` URL).
- Legacy workspace: the legacy media workflows live at `/admin-legacy`
  (pretty URL for `admin-legacy.html`), linked from the console sidebar as
  **Legacy Media**. `/admin` is a compatibility entry point that redirects
  into `/console`. Existing `/file/*` links and the legacy upload pipeline are
  untouched.
- No backend architecture was rewritten. The console is a consumer of the
  Phase 1–6C HTTP APIs, plus the small additions listed under "Backend
  additions" below.

## Information architecture

The console is the single canonical management UI. Global sections (no
project selected):

| Section | Contents |
| --- | --- |
| Overview | Deployment-wide summary drawn from real project/object metrics only |
| Projects | Create, open, rename, and deactivate projects; slug and status |
| Documentation | This product's model, endpoints, credentials, and honest limitations |

Console preferences (theme, language, and compatibility links to the legacy
workspace and landing page) live behind the topbar settings button; the
`#/settings` deep link keeps working for existing bookmarks.

Per-project sections (project id comes from the verified session/URL scope):

| Section | Contents |
| --- | --- |
| Overview | Project scopes, counts from real stats endpoints, quick links |
| Data | Telegraph Database collections, JSON records, revision metadata, schemas |
| Files | Drive (folders, uploads, trash/star), flat objects list, and the S3 endpoint + SigV4 credentials — one object engine, three surfaces |
| API | Real endpoint catalog, `tg_live_…` Bearer keys with `db:`/`storage:` scopes, short-lived JWTs (`POST /api/auth/token`, JWKS verification), request explorer, generated documentation links |

### Connect — developer onboarding center

The **AI Agent** subsection generates one project-specific prompt per
supported coding agent (Generic AI Agent, Claude Code, Cursor, Codex,
Gemini CLI) behind a **"Paste this prompt"** button. The prompt carries:
the deployment URL, the project ID, the OpenAPI URL, the documentation URLs,
the environment variable *names* (never values), Bearer authentication
instructions, and the available capabilities (generic document CRUD with
versions and preconditions, object storage, the S3-compatible endpoint).
It also mandates agent behavior: read the documentation first, inspect the
existing repository, reuse the existing integration, do not create another
database, do not introduce PostgreSQL/Prisma/Drizzle, and never commit
secrets. Agent flavors add only their durable-notes convention (CLAUDE.md,
.cursor/rules, AGENTS.md, GEMINI.md). The prompt is generated from the URL
and project ID alone — it can never contain a secret value.

The Connect section is a single onboarding page with four sections:

- **Quick Start** — three steps (issue credentials → copy `.env` → first
  request) with live status pills for credentials held in this page's memory
  and a jump nav.
- **Environment** — a reference table for `TELEGRAPH_URL`, `TELEGRAPH_PROJECT`,
  `TELEGRAPH_API_KEY`, and the `S3_*` variables with this deployment's concrete
  values, plus the generated `.env` file.
- **API** — the endpoint summary table (Document API, Object API, S3) with
  scopes, links to `/openapi.json`, the API Explorer, and API Keys, the
  generated JSON config, and the honest capability notes.
- **SDK / cURL** — copy-ready cURL and JavaScript examples. Snippets read the
  key from the environment (`$TELEGRAPH_API_KEY` / `process.env.TELEGRAPH_API_KEY`);
  the secret is never embedded in a copied command or a URL.

Issued secrets are kept in page memory only — never in localStorage,
sessionStorage, or any URL — and the credential creation flow (issue dialog →
exactly-once secret reveal → `.env` update) is unchanged.

### API Explorer

The API tab's Explorer renders the five generic CRUD operations for any
collection (list, create, read, update, delete) with: method badge, endpoint
path, parameter table, authentication (`Bearer tg_live_…`), the example
request body (schema-aware when the collection has fields), the example
response, and copy-ready cURL / JavaScript / Python snippets. Record-level
cards carry a record-ID field that feeds both "Try it" (which runs against
the dashboard-session project route, never with a developer key from the
browser) and the snippets. The Explorer links `/openapi.json` and the
project-aware OpenAPI document.
| Connect | Developer onboarding center: Quick Start, Environment, API, SDK / cURL with project-specific examples |
| Settings | Project name/slug/status and legacy workspace link |

Pre-rework deep links keep working: `drive` → `files?tab=drive`,
`database` → `data?tab=collections`, `s3`/`s3-credentials` → `files?tab=s3`,
and `keys` → `api?tab=keys`.

Legacy Media (old uploads, the push queue, albums, whitelist/blacklist,
moderation, short URLs, legacy R2/Telegram serving) stays at `/admin-legacy`
and is reached from the console sidebar footer. `/admin` redirects into
`/console`. Legacy routes were preserved, not ported or deleted.

## Drive

The Drive is a Google-Drive-style browser over the **same** object engine that
serves `/api/storage/*` and `/s3/*`; there is no second byte store.

- Buckets are top-level containers (exactly like S3 buckets). Folders are key
  prefixes; empty folders persist a small marker, and folders implied by
  object keys appear automatically.
- Uploads use the session-scoped Drive object route with progress, pause/
  cancel, per-file retry, and a bounded queue rendered in the page. Large
  buckets are read with `prefix`/`delimiter`/`limit`/`cursor` pagination;
  search is debounced and server-side; the page never loads a whole bucket
  into memory.
- Rename and move copy bytes once to the new key and tombstone the old key.
  Telegram's immutable history is never rewritten.
- Star, trash, and restore are console-level index flags (see
  `drive-state.js`). "Delete permanently" tombstones the object in the object
  index; provider retention follows the established Phase 4/5 behavior.
- Multi-select (click, Ctrl/⌘, Shift), bulk trash/move/delete, grid/list
  layouts, sort, breadcrumbs, a right-click context menu, keyboard shortcuts,
  drag-and-drop upload, and a details drawer are included.
- The details drawer offers MIME-aware preview (images, audio, video, text,
  PDF in a sandboxed frame), metadata, ETag/version, and copyable snippets:
  Direct URL, Markdown, HTML, BBCode, CSS (images only), and the Object API
  URL. Previews and downloads inside the console use the dashboard session.

### Public direct links

Every object has one unlisted public direct link:

```
GET|HEAD /p/:projectId/:bucket/*key
```

- Anonymous read-only byte delivery; no listing, metadata, or mutation
  methods (anything but GET/HEAD returns 405).
- The 22-character project id together with bucket and key forms an unlisted
  link, in the same spirit as the legacy `/file/:id` route.
- **Trashing an object immediately revokes its direct link** (the route
  returns 404 while trashed).
- Responses carry `nosniff`, a sandbox CSP, safe `Content-Disposition`,
  `Accept-Ranges`, ETag, and range support; they do not expose internal
  revision ids (`X-Telegraph-Cloud-Object-Version` is present only on the
  authenticated object route).
- There are deliberately no presigned URLs, per-file passwords, bucket
  policies, or anonymous writes. Missing objects return a generic 404; an
  unconfigured byte backend reports the same honest 503 enum used elsewhere.
- Catch-all params are percent-decoded exactly once by the shared
  `decodeRouteSegment` helper (used by the Drive route, `/p`, and
  `/api/storage`), and encoded path separators inside one segment are
  rejected, matching the S3 adapter's path rules.

## Database console

Labeled **Telegraph Database** everywhere; it is a versioned document
database, never PostgreSQL:

- Collections are first-class resources. The section's "+" action always
  means **New collection**: an explicit builder for name, description, and
  typed fields (`text`, `number`, `boolean`, `datetime`, `json`, `file`,
  `select`) with per-field required flags, default values, and select
  options. The metadata is stored server-side
  (`telegraph-cloud.collection.v1`) and drives validation of future writes.
- Records are created only inside a collection that already exists; the
  record dialog shows the open collection as read-only context, and a record
  write never creates a collection as a side effect.
- Collections created before schemas existed (schema-less) remain fully
  readable and writable; a schema can be defined on them later and then
  constrains only future writes.
- Browse collections and records with bounded lists and cursors, exact-match
  filters on indexed top-level string fields, record history (immutable
  revisions), and a JSON editor for create/PATCH/delete.
- Wires the real project-scoped routes (`/api/projects/:id/db/...`); PATCH and
  DELETE send the required optimistic `_expected_version` precondition and
  surface `version_conflict` honestly.
- The Connect view and Database docs use the developer surface
  `/api/db/:collection` with a Bearer key; the project is always derived from
  the verified key, never from a client-supplied id.
- The UI states plainly: no SQL, no psql, no wire protocol, and no Prisma/
  Drizzle PostgreSQL compatibility.

## Credentials and secrets

Two explicitly separate credential kinds:

- **API Keys** (`tg_live_…`): Bearer credentials for the document and object
  APIs. Scopes are `db:read`, `db:write`, `storage:read`, `storage:write`.
- **S3 Credentials** (`tgsk_live_…` + `secret_access_key`): SigV4 only, with
  `s3:read`/`s3:write`. They never work as Bearer keys.

- **Short-lived JWTs** (derived, never stored): `POST /api/auth/token`
  exchanges a `tg_live_…` key (or an unexpired JWT) for an ES256
  (ECDSA P-256) JWT that inherits the credential's project and scopes.
  Tokens are compact JWS with `iss`/`aud`/`sub`/project/scopes/`iat`/`exp`/
  `jti` claims and a `kid` header; default lifetime 900 s, bounded to
  60–3600 s. Any Bearer-protected developer route accepts them alongside
  API keys. Verifiers resolve public keys from `/.well-known/jwks.json`
  (public keys only — the private scalar is never published). Signing keys
  rotate via `POST /api/auth/keys/rotate` (dashboard-gated): the previous
  private key is purged from KV immediately, its public key stays published
  so outstanding tokens keep verifying until expiry. Private keys live only
  in KV and never appear in any response.

The full secret is shown **exactly once**, in a dialog that requires explicit
acknowledgement ("I saved the secret"); list endpoints return verifier-only
metadata (prefix, fingerprint, scopes, status, dates). Rotation issues a new
secret, preserves label/scopes, and revokes the old credential immediately.
Secrets are never written to localStorage, never placed in URLs, never
included in analytics or logs. The only browser-local state is the language,
theme/layout preferences, star/trash-independent UI prefs, and the legacy
push queue (unchanged). Credential creation responses are `no-store`.

## S3 console

The S3 section renders a capability matrix from the shipped Phase 6A/6B
adapter only:

- Supported: GetObject, HeadObject, PutObject, DeleteObject, ListObjectsV2,
  SigV4 header form, path-style addressing (`us-east-1` / `s3`).
- Deferred and shown as unavailable: bucket CRUD, multipart upload, presigned
  URLs, ACLs, policies, SDK certification. The backend returns explicit
  method errors; the UI never presents a deferred control as working.

Drive and S3 share the one object engine; the console does not claim S3
parity beyond the listed operations.

## Internationalization and accessibility

- The console uses the established `ti.lang` language state. English is the
  identity locale (every `ct('…')` call's source text is the message id); a
  complete Chinese (zh) catalog ships in `js/console-locales.js`. Indonesian
  falls back to English via an intentionally empty `CONSOLE_ID` catalog.
- No user-visible string is hard-coded outside the i18n system. Coverage,
  placeholder parity (`{name}` tokens), stale keys, and hard-coded CJK text
  are enforced by `test/console-i18n.test.js`.
- Markup uses semantic landmarks, a skip link, dialog roles/labels, focus
  management, `aria-current` navigation, labeled controls, and visible focus.
- CSS is responsive (collapsible sidebar, fluid grids) and honors
  `prefers-reduced-motion`. The visual language is Material 3-inspired:
  rounded surfaces, restrained elevation, no gradients/neon/glassmorphism.

## Frontend structure

```
console.html                 shell, static chrome, legacy links
css/console.css              console design system
js/console/main.js           chrome, nav, hash router, view dispatch
js/console/router.js         explicit global/project route table
js/console/store.js          session, projects, prefs
js/console/api.js            fetch wrapper (auth, JSON, error enums)
js/console/i18n.js           gettext-style ct() over the shared language state
js/console-locales.js        CONSOLE_ZH (and empty CONSOLE_ID fallback)
js/console/views/*.js        one module per IA section and Drive component
```

## Backend additions (small and additive)

| Surface | File | Purpose |
| --- | --- | --- |
| Public direct links | `functions/p/[id]/[bucket]/[[key]].js` | Anonymous GET/HEAD byte delivery; trash hides objects |
| Shared byte response | `functions/cloud/object-bytes-response.js` | Safe headers, ranges, CSP, disposition for object reads |
| Param decoding | `decodeRouteSegment` in `functions/cloud/object-request-input.js` | One-time percent decoding for all three object routes |

The Drive object route and `/api/storage` route now share the byte-response
builder and the decoder; no response contract changed for existing clients.

## Local development

```bash
npm ci
npm test                 # mocha, including console i18n and DOM tests
npm run start:cloud      # KV + peppers bound; byte PUTs need Telegram config
```

`start:cloud` binds `TELEGRAPH_CLOUD_KV` and dev peppers (`API_KEY_PEPPER`,
`TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER`) so projects, the document database
control plane, keys, and S3 credentials work locally. Object byte uploads
additionally require valid Telegram configuration (`TG_Bot_Token`,
`TG_Chat_ID`); without it the UI shows the honest "object backend not
configured" state rather than fabricating success.

Tests added for the console:

- `test/console-i18n.test.js` — catalog coverage, `{placeholder}` parity,
  stale/empty keys, no hard-coded Chinese in console sources.
- `test/console-dom.test.js` — boots the real `console.html` and real ES
  modules under jsdom with scripted APIs (routing, Drive drawer + direct-link
  snippets, project creation dialog, one-time-secret flow, zh chrome,
  document-DB framing).
- `test/public-direct-links.test.js` — `/p` route behavior, safe headers,
  trash revocation, range/method/error cases, and param decoding.

## Explicit non-goals

This phase does not add PostgreSQL or any SQL layer, public anonymous writes,
presigned URLs, multipart uploads, bucket creation over S3, analytics,
billing, SDKs, globally exact rate limits, or a replacement for the legacy
workspace. Missing capabilities are either backed by the small endpoints
above (direct links, folders/trash/star flags from earlier phases) or shown as
disabled/deferred with documentation — never as fake frontend-only state.
