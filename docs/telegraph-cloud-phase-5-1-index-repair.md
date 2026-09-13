# Telegraph Cloud — Phase 5.1: Operator Object-Index Repair

Phase 5.1 adds a deliberately narrow **operator-only** repair checkpoint for the bounded Phase 5 object-list index. It rebuilds deterministic terminal leaves and any required missing branch markers from authoritative current object manifests without changing the public `/api/storage/*` contract, object bytes, revisions, or Telegram retention behavior.

> **Status:** experimental self-hosted maintenance workflow. It is not a public storage API, S3 feature, bucket-management API, background reconciliation service, or replacement for the Phase 4/5 object engine.

Read [Phase 4 object storage](telegraph-cloud-phase-4-object-storage.md) for the append-oriented object lifecycle and [Phase 5 object semantics](telegraph-cloud-phase-5-object-semantics.md) for listing/ranges. This document is the source of truth for the repair checkpoint.

## Why repair exists

Phase 5 list leaves are deliberately secondary materializations. The current Phase 4 manifest remains authoritative because it carries the active/tombstoned state, safe public metadata, logical version, and internal immutable-revision relationship. The list index can lag when a ready outbox requires retry, an operator is migrating Phase 4 objects written before Phase 5, or bounded KV materialization is interrupted.

Normal public listing never trusts a leaf as object truth: it reads the current manifest before returning an entry, so stale leaves cannot resurrect a tombstone or leak an internal pointer. However, a missing leaf makes an otherwise active object absent from a list, and a retained deleted leaf costs bounded traversal work. Phase 5.1 lets a dashboard operator inspect/repair those deterministic leaves in small, resumable batches.

## Scope and authorization

The only endpoint is:

```text
POST /api/projects/:projectId/storage/index-repair
```

It lives below the existing `/api/projects/*` middleware and therefore requires the existing dashboard HMAC session or `BASIC_USER`/`BASIC_PASS` Basic authentication. It is intentionally **not** under `/api/storage/*`:

- a developer `tg_live_…` API key, regardless of storage scope, receives the dashboard authentication failure and cannot run repair;
- there is no unauthenticated/public repair URL, GET status feed, presigned URL, or client project selector;
- the route accepts only `POST` (`405 Allow: POST` otherwise);
- active and disabled projects may be repaired by an administrator; logically deleted projects remain unavailable.

The project path selected by the authenticated administrator is the sole project scope. Project ID, bucket, checkpoint, and all KV records are validated server-side. The response never includes Telegram file/message IDs, Telegram paths, Bot API URLs/tokens, credentials, raw KV key names/cursors, revision IDs, parent pointers, or object content.

## Deployment prerequisites

No new binding is required.

| Setting | Why it is needed |
| --- | --- |
| `TELEGRAPH_CLOUD_KV` | Holds authoritative manifests and bounded Phase 5 list-index state. The repair reads/writes this dedicated namespace only. It never stores bytes. |
| `API_KEY_PEPPER` | At least 32 UTF-8 bytes. It derives a separate domain-separated AES-GCM key for opaque repair checkpoints. A changed pepper invalidates outstanding checkpoints. |
| `BASIC_USER` and `BASIC_PASS` | Required by the existing dashboard/project middleware. Without them, the route fails closed. |

Repair does not download object bytes, call `getFile`, upload to Telegram, append an object event, mutate an object manifest, alter a logical version/ETag, or physically delete Telegram content. Telegram credentials are not needed for a repair-only invocation once the object engine has already persisted manifests.

## Operator API

Start a bounded scan with a JSON request body:

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dry_run","bucket":"assets","batch_size":25}' \
  'https://your-domain.example/api/projects/prj_ServerGeneratedOpaqueId/storage/index-repair'
```

| Field | Rule |
| --- | --- |
| `mode` | Required: `dry_run` or `apply`. `dry_run` is the safe inspection mode; `apply` can write/remove only deterministic list-index state needed for an authoritative manifest's path. |
| `bucket` | Optional safe Phase 4 bucket name. Omit it to scan bounded manifest pages across the selected project. It does not create or manage buckets. |
| `batch_size` | Optional integer, default `25`, minimum `1`, hard maximum `50`. It bounds one manifest-index page and one HTTP request. |
| `checkpoint` | Used **instead of** the three start fields to resume. Send only `{ "checkpoint": "…" }`, unchanged. Combining it with mode/bucket/batch fields is rejected. |

An apply request for one bucket is otherwise identical:

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"apply","bucket":"assets","batch_size":25}' \
  'https://your-domain.example/api/projects/prj_ServerGeneratedOpaqueId/storage/index-repair'
```

Representative safe response:

```json
{
  "operation": "object_index_repair",
  "mode": "apply",
  "bucket": "assets",
  "batch_size": 25,
  "page": 1,
  "complete": false,
  "status": "in_progress",
  "batch": {
    "scanned": 25,
    "repaired": 2,
    "removed": 1,
    "stale": 3,
    "skipped": 22,
    "errors": 0
  },
  "progress": {
    "scanned": 25,
    "repaired": 2,
    "removed": 1,
    "stale": 3,
    "skipped": 22,
    "errors": 0
  },
  "checkpoint": "opaque-encrypted-continuation"
}
```

When `complete` is false, use the returned checkpoint exactly:

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"checkpoint":"opaque-encrypted-continuation"}' \
  'https://your-domain.example/api/projects/prj_ServerGeneratedOpaqueId/storage/index-repair'
```

The final page has no checkpoint. Its status is `completed` when no record errors occurred, or `completed_with_errors` when the scan reached the end but one or more malformed/corrupt authoritative records were skipped. `completed_with_errors` is intentionally not a silent repair success.

### Progress counters

Both `batch` and cumulative `progress` contain only safe counts:

| Counter | Meaning |
| --- | --- |
| `scanned` | Manifest-index entries examined. This includes malformed entries so the operator can see bounded progress. |
| `stale` | A current manifest required a missing/stale/invalid active terminal leaf or required branch-marker rebuild, or a tombstone still had a deterministic leaf. In dry-run this is work that would be attempted. |
| `repaired` | In `apply` mode, active deterministic index paths successfully created or rebuilt (the terminal leaf and, where missing, required shared branch markers). It is always zero in dry-run. |
| `removed` | In `apply` mode, a deterministic leaf belonging to an authoritative deleted manifest was successfully removed. It is always zero in dry-run. |
| `skipped` | Already-correct leaves, tombstones with no leaf, transiently absent listed manifests, or records intentionally not repaired due to a record error. |
| `errors` | Malformed manifest/list-record conditions that need operator attention. No raw error, key, pointer, or provider diagnostic is returned. |

Counters describe the current bounded traversal attempt. Replaying a checkpoint after an apply is safe, but a leaf repaired by the first attempt can appear as `skipped` on the replay rather than incrementing `repaired` again.

## Authoritative repair architecture

The workflow is manifest-first and bounded:

1. It calls the dedicated KV index only for one page of `object-manifest` records in the selected project (and optional bucket).
2. Every listed key is parsed as an internal record identity, then its manifest is fetched and validated with the same Phase 4 manifest normalizer used by object storage.
3. For each valid manifest, it derives the Phase 5 deterministic chunked terminal location and **inspects** that leaf. The leaf is never used to reconstruct object metadata, bytes, revision state, or authorization.
4. For an authoritative active manifest, a missing branch marker, missing/invalid/stale terminal leaf, or both is created/rebuilt in `apply` mode. For an authoritative tombstone, an existing deterministic terminal leaf is removed in `apply` mode.
5. Required shared branch markers are created write-once from the same manifest path. They are retained on deletion: removing one safely would need an atomic child count, which Cloudflare KV does not provide; retaining it is non-public and preserves concurrent sibling safety.

The Phase 5 list engine still revalidates manifests during ordinary public listing. Repair improves index completeness/work efficiency; it does not change list ordering, pagination, range handling, metadata visibility, object revisions, or deletion semantics.

### What is safely detectable

Because the scan begins with manifests, it can safely detect:

- an active authoritative manifest with a missing deterministic terminal leaf or a missing deterministic branch marker needed to reach it;
- an active manifest whose deterministic terminal leaf is malformed or has mismatched non-authoritative identity fields;
- a deleted authoritative manifest that still has a deterministic leaf, including a malformed terminal value;
- already-correct active leaves and deleted manifests with no leaf.

A manifest scan intentionally does **not** enumerate arbitrary orphan leaves for which no current manifest exists. Without a separate bounded raw-index sweep, a leaf alone is not enough authority to prove that a deletion is safe. Such orphan leaves remain non-public because normal listing manifest-revalidates them, but can consume traversal work. This limitation is explicit rather than risking unsafe shared-branch deletion or treating an index record as truth.

## Checkpoint and retry semantics

A checkpoint is an opaque, self-contained AES-GCM authenticated/encrypted state derived with a domain-separated key from `API_KEY_PEPPER`. It includes only the validated project/bucket/mode/batch selection, the Cloudflare KV continuation cursor, bounded cumulative counts, and timestamps; all of that state is encrypted. It is not a KV key, API key, object identifier, or credential.

- Checkpoints are bound to the project path. Using one from project A in project B, tampering with it, changing it, or using it after approximately **24 hours** returns a safe `400 invalid_object_index_repair_checkpoint`.
- A resume request cannot change the original mode, bucket, or batch size. Start a new scan for a new selection.
- No checkpoint record is written to KV. This makes dry-run fully read-only and prevents a checkpoint hot key; the operator must retain the latest returned token until completion.
- A request processes at most one page. It issues a next checkpoint only after the page finishes successfully. It never scans an unbounded project/bucket in one request.
- Retrying the exact initial request or exact checkpoint reprocesses at most that same bounded page. Deterministic leaf writes/removals are idempotent, so retries do not change object manifests or create Telegram duplicates.

Cloudflare KV is eventually consistent and the checkpoint is not a snapshot. An object mutation can race a repair batch. Each action is based on the current manifest visible to that request; normal mutation outbox replay will later materialize its own current leaf. Operators should avoid running overlapping repair scans for the same project/bucket and repeat a dry-run before/after a large apply if a stable operational report is required.

## Failure handling

A malformed manifest or malformed manifest-index entry is counted as `errors`/`skipped` and does not abort the rest of its bounded page. The final response becomes `completed_with_errors`, exposing the count but never the malformed record, raw KV key, pointer, or diagnostic. Investigate and repair authoritative data through an operator-controlled recovery procedure; Phase 5.1 does not guess at a corrupt manifest.

A transient KV/list/index failure returns a safe retryable `503` (for example `object_index_repair_unavailable` or an index backend error). It emits no successful next checkpoint for the incomplete page. Retry the exact request/checkpoint after the dependency recovers. Some earlier deterministic leaf writes may already have succeeded, but replay is safe and reports the later current state; the workflow does not falsely mark an incomplete page as complete.

If a repair needs to materialize through a corrupt shared branch, that branch is intentionally not overwritten blindly. The affected record is counted as an error so another valid manifest can still be processed. A malformed branch that remains reachable is not authority data and is retained rather than aggressively rewritten. This keeps shared-marker concurrency safety ahead of cleanup.

## Operational procedure

1. Ensure the Phase 4/5 deployment is live with the dedicated `TELEGRAPH_CLOUD_KV`, a stable `API_KEY_PEPPER`, and dashboard credentials.
2. Start with a small bucket-scoped `dry_run` (`batch_size` 25 or lower). Record `progress`, `stale`, and `errors` only; no KV data is changed.
3. Continue with each returned checkpoint until `complete: true`. If `status` is `completed_with_errors`, stop and investigate the authoritative manifest issue; do not call the endpoint repeatedly expecting it to become successful.
4. If the dry-run is clean enough to proceed, start a new bucket/project-scoped `apply` scan. Continue its own checkpoints until complete.
5. Run a fresh dry-run after apply. Existing correctly rebuilt index paths should be counted as `skipped`; active missing/stale paths or deleted retained-terminal-leaf counts should be zero absent concurrent mutations.
6. For a legacy Phase 4 migration, use small bounded batches and repeat by bucket. Do not edit list keys/cursors manually, do not expose the endpoint to applications, and do not use a developer storage key.

## Limits and exclusions

- Maximum repair batch: **50** manifests; default **25**.
- One HTTP request processes one bounded KV list page only.
- Checkpoint input is bounded to 12 KiB; the dashboard control request is bounded to 16 KiB.
- The checkpoint validity window is approximately 24 hours.
- The route inherits the existing `/api/projects/*` local mutation guard (30 POST/PATCH/DELETE requests per 60 seconds for one dashboard identity in one isolate). A `429` includes `Retry-After`; retain the latest checkpoint and resume after it. This is intentionally not distributed/global rate accounting.
- No object bytes are stored/read, no Telegram request is made, and no public API behavior changes.
- No scheduler, background worker, dashboard redesign, billing/analytics, S3 XML, SigV4, presigned URLs, multipart upload, multipart ranges, AWS SDK compatibility, public version/history API, CLI, or SDK is added.

## Verification included

Focused tests cover missing leaves and required long-key branches, stale/malformed terminal leaves, authoritative tombstones, already-correct leaves, dry-run no-mutation behavior, bounded pagination/resume, encrypted/tamper-resistant checkpoints, project isolation, idempotent repeated execution, corrupt-manifest continuation/error status, transient retry behavior, operator-only route access, safe output, and existing Phase 0–5 regressions.

Run before deployment:

```bash
node --check functions/cloud/object-index-repair.js
node --check functions/api/projects/[id]/storage/index-repair.js
node --check functions/cloud/object-list-index.js
node --check functions/cloud/object-storage.js
node --check test/object-index-repair.test.js
git diff --check
npx mocha test/object-index-repair.test.js test/object-semantics.test.js test/object-storage.test.js --reporter dot
npm test
```

## Deliberately deferred Phase 6 recommendation

Do not add S3 compatibility next. First gather operational experience with this bounded repair checkpoint. If a follow-on is justified, scope it to an **operator-only raw-index audit planner** that can identify orphan leaves/retained branch pressure in separately checkpointed, manifest-revalidated passes, with dry-run-first output and no public pointers. It needs its own concurrency and retention threat model. Keep it separate from SigV4, S3 XML, presigned URLs, multipart, SDKs, and public management features.
