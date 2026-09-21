# Telegraph Cloud — Phase 10: Schema-enforced record validation

Phase 10 makes collection schemas actually enforce record validation and
proves it with a dedicated regression suite. Optimistic versioning,
idempotency, the journal, KV indexes, conflict handling, and recovery
behavior are unchanged. Schema-less collections keep working. No
authentication changes, no JWT/JWKS work, no SQL/PostgreSQL/ORMs.

## Audit result

The enforcement core already existed end-to-end and was verified path by
path:

- **Create** (`createDocument`): read schema → apply defaults → validate
  (required, types, select options, unknown-field rejection) → only then the
  idempotency fingerprint, outbox intent, journal append, and KV
  materialization. Invalid documents never reach the journal.
- **Patch** (`patchDocument`): expected-version check first (409 wins
  deterministically over 400), then the merged current+patch document is
  validated; the patch may not add out-of-schema fields, while legacy fields
  that predate the schema remain readable and are never rejected on reads or
  untouched patches.
- **Delete**: whole-record tombstone, no schema validation needed.
- **Recovery**: validation happens before the journal, so every journaled
  revision is the canonical validated document (defaults included); replays
  materialize from that immutable revision — no re-validation divergence, no
  bypass. Conflict receipts and `mutation_pending` recovery semantics are
  untouched.
- **Surfaces**: the dashboard project routes and the legacy Bearer `/api/db`
  surface share the same service; `schema_validation_failed` maps to a safe
  `400 {error}` on both.

## Real defect found and fixed: empty-string filter index keys

The new regression suite caught a pre-existing data-plane bug: filter index
keys embed `base64url(value)`, and `base64url('')` is the empty string, which
fails the index key segment charset (`INDEX_SEGMENT_PATTERN` requires a
non-empty segment). Any document with an empty-string top-level string field
— a natural schema case with `default: ''` — journaled successfully but could
**never materialize**: every retry resumed the pending mutation and failed
key construction again, leaving a permanent `mutation_pending` 503 with the
record unreachable.

Fix (`functions/cloud/document-database.js`): `encodeFilterValue` maps the
empty string to a fixed one-character sentinel (`'0'`). It cannot collide
with a real encoding: base64url lengths are 0 or ≥ 2 (lengths mod 4 are only
0, 2, 3), and every non-empty UTF-8 string starts with a byte whose leading
sextet is alphanumeric in base64url. The value cap (64 bytes) keeps all real
encodings within the segment length limit. Empty values are now materialized,
readable, and exactly queryable (`?note=`).

## Regression suite (`test/schema-enforcement.test.js`, 17 cases)

- Create matrix: all seven field types (valid + invalid), `null` rejection
  for scalars / acceptance for `json`, unknown-field rejection, falsy
  defaults (`0`, `false`, `''`, JSON object, select default), explicit values
  winning over defaults, and the defaulted document verified in the stored
  index record.
- Patch matrix: merged-document validation, no-new-fields rule, legacy-field
  tolerance, required-on-merge for legacy records, defaults **not** injected
  on patch (existing records are never implicitly rewritten), failed patches
  leaving records untouched, and `version_conflict` (409) taking precedence
  over schema errors.
- Idempotency & recovery with schemas active: same-key replay returns the
  same defaulted result with a single journal entry and the applied-outbox
  TTL; a different payload on the same key → 409; an injected index failure
  after the journal append → `mutation_pending`, and the same key recovers
  the exact validated revision with no second journal entry; invalid
  documents never append to the journal.
- Empty-string regression: empty defaults materialize, are exactly filterable
  (`?note=` vs `?note=x`), and can be introduced by patch or through
  schema-less writes.
- Schema-less coexistence: arbitrary JSON accepted in a schema-less sibling
  while the schema'd collection enforces.
- HTTP: the project-scoped collection route returns `400
  {error:'schema_validation_failed'}` for violations and `201` with defaults
  for valid records.

Full suite after the change: **546 passing, 0 failing** (was 529). Verified
live under `wrangler pages dev`: metadata creation, select/type/unknown-field
400s, defaults satisfying required selects, and schema-less writes bypassing
validation.
