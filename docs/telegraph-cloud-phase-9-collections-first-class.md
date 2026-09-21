# Telegraph Cloud — Phase 9: Collections as first-class resources

Phase 9 completes the Data/Collections story: collections are explicit,
metadata-backed resources; record creation can never create a collection as a
side effect. No authentication changes; no JWT/JWKS work; the legacy
schema-less behavior is preserved.

## Behavior

- **"+" → New Collection.** The Data section's primary action (page header on
  every Data tab, and every empty state) is a single "+" button that opens
  the New Collection builder. There is no record shortcut at the section
  level.
- **New Collection builder** collects:
  - Collection name (server-validated identifier)
  - Description (stored, ≤1,000 bytes)
  - Fields, each with: name, type, required flag, default value, and — for
    `select` — a comma-separated option list.
  - Field types: `text`, `number`, `boolean`, `datetime`, `json`, `file`,
    `select`.
  - The builder validates next to the control: field-name pattern
    (`[a-z][a-z0-9_]*`), uniqueness, select fields require at least one
    option, and select defaults must be one of the listed options.
- **Explicit metadata storage.** Definitions are stored in the project
  database's `collectionMeta` index as `telegraph-cloud.collection.v1`
  (`{ schema, name, description, fields }`) via
  `POST /api/projects/:id/db/collections` and
  `PATCH …/db/collections/:name`. This API shipped with the collection-schema
  work; this phase completes the UI contract around it.
- **Records stay inside existing collections.** The record dialog now shows
  the open collection as read-only context (`New record · {collection}`);
  the free-text collection input was removed, so a record write can no longer
  target a not-yet-existing collection. Records keep their full CRUD,
  versioning, `_expected_version` preconditions, and history.
- **Schema-less compatibility.** Collections that predate metadata (no
  `collectionMeta` record) remain fully readable and writable with arbitrary
  JSON. Defining a schema on them later constrains future writes only;
  existing records are never rewritten.

## Small backend robustness fix

`fieldTypeProblem` in `functions/cloud/collection-schema.js` dereferenced a
missing `options` list for `select` fields declared without options, turning
a definition or write into an internal error. It now reports the controlled
problem (`must be one of the declared options (none are declared)`) through
the normal `schema_validation_failed` / `invalid_collection_field_default`
paths. A select field with no options still cannot accept values — but it now
fails honestly instead of crashing.

## UI fixes found during the phase

- The create-collection dialog re-created the default-value input on field
  type changes without binding its value, visually losing typed defaults
  (state and UI disagreed). The binding is fixed, and select fields can now
  carry a default (the backend always supported it; the builder hid it).
- Duplicate "New collection" buttons (page head + tab header) consolidated
  into the single "+" action.

## Compatibility unchanged

- `/api/db/*` legacy surface, `/api/projects/:id/db/*` routes, and all
  record semantics are untouched.
- Authentication untouched (dashboard session for the console; Bearer keys
  and SigV4 exactly as before). No JWT/JWKS work in this phase.

## Tests

- `test/console-dom.test.js` — new cases: "+" opens the New Collection
  builder and POSTs explicit metadata (name/description/select field with
  options + default); builder mistakes surface next to the control (select
  without options sends nothing); the record dialog is locked to the open
  collection.
- `test/collections-schema.test.js` — new case: select fields declared
  without options produce controlled definition/write errors (no crash).
- Full suite: `npm test` — all tests pass after the change.
