# Telegraph Cloud — Phase 11: API developer experience

Phase 11 audits and completes the developer-experience surface: generic
runtime CRUD for every collection, a full API Explorer in the console, and
the OpenAPI document — with no per-collection source generation and no
compatibility changes.

## Audit result

- **Generic CRUD routes (already complete, verified and pinned).** Every
  collection is served by generic dynamic routes; no source files are
  generated per collection:
  - Legacy Bearer surface: `GET|POST /api/db/:collection`,
    `GET|PATCH|DELETE /api/db/:collection/:id`.
  - Dashboard project surface: `GET|POST /api/projects/:id/db/:collection`,
    `GET|PATCH|DELETE /api/projects/:id/db/:collection/:record` (+ revision
    history).
  Both surfaces share the same document-database service; methods, error
  contracts, optimistic preconditions, and idempotency are identical.
  `test/openapi.test.js` maps every documented path to the real function
  file and asserts the handled methods; `test/db-api.test.js` and
  `test/project-console-api.test.js` exercise the routes end-to-end.

- **`/openapi.json` (already shipped, kept intact).** OpenAPI 3.1 generated
  from the actual supported surface (catalog in
  `functions/cloud/openapi.js`), with an accuracy test asserting no invented
  endpoints and no documented-but-unhandled methods. It documents exactly:
  the five collection CRUD operations, object storage (Bearer) and the S3
  endpoint (SigV4), health and discovery — and states explicitly that
  multipart uploads, presigned URLs, and bucket policies are not implemented.
  The project-aware variant (`/api/projects/:id/openapi.json`, dashboard
  session, fails closed) adds `x-collections` with example request bodies
  derived from each collection's stored schema.

## Completed in this phase: the API Explorer

`js/console/views/explorer.js` (Project → API → Explorer) now renders every
requested element per operation:

- **Endpoint + method** badge and path for the five CRUD operations of the
  selected collection.
- **Authentication** (`Bearer tg_live_…`) with copy button — the Explorer
  never handles or displays a real key.
- **Parameters** table (limit/cursor/filters, path IDs, Idempotency-Key).
- **Request body** section: the schema-aware example document, shown as a
  labeled code block (previously only embedded inside snippets).
- **Response** section: the example response JSON as a labeled code block
  (previously computed but never rendered).
- **cURL / JavaScript / Python** snippet tabs with `$TELEGRAPH_API_KEY` /
  `$RECORD_ID` environment placeholders (no secret values, ever).
- **Record-ID input** on record-level cards: "Try it" requires a real ID
  (guarded with a clear message, no request is made without one) and runs
  against the dashboard-session project route; a filled ID also flows into
  the copied snippets.
- Links to `/openapi.json` and the project-aware OpenAPI document.

## Compatibility

No route, method, auth, error-code, or response-shape changes. The Explorer
additions are console-only; the OpenAPI document is unchanged from its
shipped, accuracy-tested form.

## Tests

- `test/console-dom.test.js` — new Explorer case: exactly the five CRUD
  cards in order, authentication on every card, request-body sections on the
  three mutating operations, response sections everywhere, cURL default with
  JavaScript tab switching, record-ID guard (no request without an ID),
  entered ID flowing into snippets, and OpenAPI links present.
- `test/openapi.test.js` — new explicit case pinning the complete generic
  CRUD surface (`get`,`post` on the collection path; `get`,`patch`,`delete`
  on the record path).
- Full suite: **548 passing, 0 failing**. Verified live under
  `wrangler pages dev`: `/openapi.json` serves the 3.1 document with the
  generic CRUD paths, the project OpenAPI fails closed anonymously (401) and
  emits schema-derived examples when authenticated, and the generic routes
  serve any collection (200 list / 404 unknown record).
