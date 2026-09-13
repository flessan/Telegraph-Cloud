# Telegraph Cloud — Phase 6A: historical S3 protocol bridge

> **Superseded by [Phase 6B SigV4 access](telegraph-cloud-phase-6b-sigv4.md).**
> This document is retained as historical migration context only. Do not deploy
> or rely on the Phase 6A Basic/session/test-project authorization model.

Phase 6A originally introduced the dedicated `/s3/*` XML protocol adapter over
the project-scoped Telegraph Cloud object facade. Its temporary authentication
model was deliberately administrator-only: dashboard Basic/session identity
plus a server-configured `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` selected one
project for every S3-shaped request.

That temporary bridge has been removed from production S3 routing in Phase 6B:

- `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` is no longer read as S3 authority.
  Leaving the obsolete setting in an environment does not enable a bypass.
- Dashboard Basic/session credentials no longer authenticate `/s3/*` object
  requests. They remain only for dashboard/project/credential administration.
- `tg_live_…` Developer Bearer keys remain distinct and do not authenticate
  `/s3/*`.
- `/s3/*` now requires a real, header-form `AWS4-HMAC-SHA256` request with an
  active `tgsk_live_…` S3 credential. The verified credential alone derives
  project and `s3:read`/`s3:write` authority.

## What Phase 6B preserves

The protocol-only adapter and existing object engine remain separate:

```text
verified SigV4 credential -> S3 XML adapter -> project-bound object facade
                         -> existing Telegram + repairable KV object engine
```

The adapter still provides only path-style ListObjectsV2 plus object
PUT/GET/HEAD/DELETE. It still invokes the object facade rather than Telegram or
KV directly, retains bounded listing/range/conditional semantics, emits safe
XML errors/request IDs, and does not alter `/api/storage/*`, `/api/db/*`,
`/api/projects/*`, `/upload`, `/file/*`, dashboard media behavior, legacy
Telegram/R2 behavior, or public links.

It remains **not** S3/R2 equivalence, bucket CRUD, multipart, ACL/policy,
presigned URL, copy/tagging/checksum/SSE/object-lock support, AWS SDK
certification, billing/analytics, or a dashboard redesign.

## Migration from a Phase 6A deployment

1. Remove `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID`; it is obsolete and must not be
   treated as a fallback.
2. Configure the dedicated Phase 6B S3 credential pepper and exact public
   endpoint host, then create dashboard-managed S3 credentials for the intended
   projects.
3. Update clients from Basic/session access to fixed-region/service header-form
   SigV4. Existing Phase 6A outer continuation tokens are intentionally
   invalid under Phase 6B.
4. Keep the original object-engine persistence/recovery guidance from
   [Phase 4](telegraph-cloud-phase-4-object-storage.md),
   [Phase 5](telegraph-cloud-phase-5-object-semantics.md), and
   [Phase 5.1](telegraph-cloud-phase-5-1-index-repair.md).

Read the [Phase 6B reference](telegraph-cloud-phase-6b-sigv4.md) for required
configuration, one-time credential lifecycle, canonicalization, payload,
skew/replay policy, supported operations, security boundaries, and current
verification steps.
