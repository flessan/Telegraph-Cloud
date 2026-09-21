# Telegraph Cloud — Phase 13: AI Agent onboarding under Connect

Phase 13 adds an **AI Agent** section to the project Connect page. Console
and documentation layer only — no backend, auth, or API changes.

## What it does

The section makes it a one-paste operation for a coding agent to connect an
application to a Telegraph Cloud project. Five agent flavors are supported
behind tabs:

- Generic AI Agent
- Claude Code (durable notes in `CLAUDE.md`)
- Cursor (durable rules in `.cursor/rules`)
- Codex (durable guidance in `AGENTS.md`)
- Gemini CLI (durable context in `GEMINI.md`)

Each flavor renders its generated prompt and a **"Paste this prompt"**
button that copies the prompt for pasting into the agent, with a confirming
toast. The flavor preamble differs only in the agent identity and its
durable-notes convention; the core prompt is shared.

## Prompt contents (project-specific, generated from live context)

- Telegraph Cloud URL (deployment origin)
- Project ID
- OpenAPI URL (`/openapi.json`)
- Documentation URL (`/docs/ai`, plus `/llms.txt` and `/llms-full.txt`)
- Environment variable **names** with placeholders: `TELEGRAPH_URL`,
  `TELEGRAPH_PROJECT`, `TELEGRAPH_API_KEY` (and the `S3_*` names for object
  storage)
- Authentication instructions (Bearer header from the environment; keys are
  created in the console, shown exactly once, stored in a gitignored `.env`;
  S3 uses separate SigV4 credentials)
- Available capabilities: generic document CRUD routes for every collection
  (versioned records, `_expected_version`, Idempotency-Key, filters,
  pagination, schemas), object storage routes, and the S3-compatible
  endpoint — plus the honest "not available" list (SQL, psql, multipart,
  presigned URLs)

## Mandated agent behavior (verbatim in every prompt)

1. Read the documentation first (fetch the docs and OpenAPI before writing code).
2. Inspect the existing repository before adding anything.
3. Reuse the existing integration; extend, never fork or duplicate.
4. Do not create another database — Telegraph Cloud is the data layer.
5. Do not introduce PostgreSQL, Prisma, or Drizzle (or any SQL database/ORM).
6. Never commit secrets — the key lives only in a gitignored `.env`, read at
   runtime.

## Secret safety

The prompt is generated exclusively from the deployment URL and the project
ID. No credential value is ever read while building it, so no secret can
appear in the prompt, the preview, the clipboard, or (per the existing
guarantees) any URL or web-storage. A DOM test proves the prompt and the
clipboard stay secret-free even with a key issued in the same session.

## Tests

- `test/console-dom.test.js` — new case: five agent tabs; the prompt carries
  all required facts (URL, project ID, OpenAPI/docs URLs, env-var names,
  auth instructions, capabilities) and all six mandates; the prompt and the
  copied clipboard never contain secret material, even after issuing a key
  in-session; the Claude Code flavor includes its preamble; "Paste this
  prompt" copies the exact prompt with a confirming toast.
- Full suite: **550 passing, 0 failing** (was 549).
