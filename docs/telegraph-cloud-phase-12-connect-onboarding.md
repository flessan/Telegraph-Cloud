# Telegraph Cloud — Phase 12: Connect as a developer onboarding center

Phase 12 redesigns the project Connect section into a proper onboarding
center. Console-only change: no API, auth, or storage behavior was touched.

## Sections

- **Quick Start** — three steps with in-place actions: issue credentials
  (API key / S3 credentials), copy the generated `.env`, and copy a first
  request. Live status pills show what is held in this page's memory; a
  jump nav scrolls to the other sections.
- **Environment** — a variable reference table (`TELEGRAPH_URL`,
  `TELEGRAPH_PROJECT`, `TELEGRAPH_API_KEY`, `S3_ENDPOINT`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) with this deployment's concrete
  values and per-variable purpose, followed by the generated `.env` and the
  issue buttons.
- **API** — endpoint summary table (Document API with the five generic CRUD
  routes + history, Object API, S3) with auth scopes; links to
  `/openapi.json`, the API Explorer, and API Keys; the generated JSON config;
  and the honest capability notes (not PostgreSQL; no multipart/presigned).
- **SDK / cURL** — cURL and (new) JavaScript `fetch` examples covering list,
  create, optimistic update, and object upload.

## Project-specific generation

Every artifact is generated from the live project context:
`TELEGRAPH_URL` (deployment origin), `TELEGRAPH_PROJECT` (project id), and
`TELEGRAPH_API_KEY` (the issued key, or a visible placeholder until one is
issued). `.env`, JSON config, cURL, and JavaScript all regenerate the moment
a credential is issued.

## Secret handling (unchanged guarantees, strengthened snippets)

- Secrets live in **page memory only** — never localStorage/sessionStorage,
  never a URL. Pinned by a DOM test that inspects both storages and the URL
  before and after issuing.
- cURL/JavaScript snippets now reference `$TELEGRAPH_API_KEY` /
  `process.env.TELEGRAPH_API_KEY` instead of embedding the secret in the
  copied text; only the `.env` (whose purpose is to be copied into the
  user's environment) carries the value while it is held in memory.
- The existing credential creation flow is intact: issue dialog (label +
  scopes) → creation via `POST /api/projects/:id/keys` or `/s3-credentials`
  → exactly-once secret dialog with acknowledgement → `.env` update toast.
  Rotation/revocation remain in the API Keys / S3 Credentials sections.

## Tests

- `test/console-dom.test.js` — new Connect case: four sections present;
  `.env` embeds the real origin and project id; cURL reads
  `$TELEGRAPH_API_KEY`; JavaScript reads `process.env.TELEGRAPH_API_KEY`;
  the full issue flow works end-to-end against the scripted API and the
  secret appears in the `.env` (in memory) but never in localStorage,
  sessionStorage, or the URL.
- i18n: +33 zh catalog entries, 3 stale keys removed; catalog tests pass.
- Full suite: **549 passing, 0 failing**. Verified live under
  `wrangler pages dev`: key and S3-credential creation return the one-time
  secret plus verifier-only metadata, the issued key authenticates the
  documented generic route via header, and `/console` serves.
