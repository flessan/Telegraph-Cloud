# Telegraph Cloud — Phase 15: Developer documentation (machine + human)

Phase 15 finishes the developer-experience rework: the documentation links
the console has advertised since phase 11 are now real, generated endpoints,
plus a complete human documentation set. No data-plane behavior changed.

## Machine-readable surfaces (new routes)

| Route | Content |
| --- | --- |
| `GET /llms.txt` | Concise digest for coding agents (llms.txt convention): what the service is (and explicitly is not), base URL, 3-step start, working curl examples, authentication summary, the real endpoint table, hard rules (versioning, idempotency, burst guard, limits, non-goals, secret hygiene), and the documentation map. |
| `GET /llms-full.txt` | Every documentation topic in one plain-text document (705 lines), for agents that want the whole picture in one fetch. |
| `GET /.well-known/telegraph.json` | Service metadata: `console`, `/admin` compatibility, all documentation endpoints, bearer + JWT parameters (algorithm, audience, TTLs, issuer env, rotation), S3 SigV4 parameters, capability flags — including honest `false` entries (SQL, wire protocol, ORM compatibility, multipart, presigned URLs, bucket policies) — and limits. |
| `GET /docs/[[page]]` | Human-readable HTML pages. `/docs` lands on Getting started. |

All four are public, `Cache-Control: public, max-age=300`, rooted at the
requesting origin, and fail with `405` on unsupported methods.

## Human documentation (11 topics)

`/docs/getting-started`, `projects`, `collections`, `crud`, `api-keys`,
`jwt`, `jwks`, `storage`, `s3`, `ai` (AI agents), `self-hosting` — plus:

- `/docs/ai` — the AI-agent integration guide (human + machine readable):
  nine direct instructions, from "fetch the docs before writing code" to
  capability honesty and the no-second-database / no-ORM / never-commit-
  secrets mandates.
- `/docs/ai-agent` — a copy-ready plain-text onboarding brief
  (`text/markdown`) agents can fetch directly and paste into AGENTS.md /
  CLAUDE.md / .cursor/rules.

Pages are rendered by a small, dependency-free markdown renderer (headings,
fenced code, tables, lists, links) with an inline stylesheet, full HTML
escaping, and no scripts or external assets.

## One source of truth — accuracy by construction

`functions/cloud/developer-docs.js` is the single content module. It imports
the constants the implementation uses and interpolates them into the prose:

- the OpenAPI route catalog (`DATA_PLANE`, now exported) for every endpoint
  table and mention;
- `API_KEY_SCOPES`, `JWT_TTL`, `JWT_AUDIENCE`, `JWT_ISSUER_ENV`,
  `S3_SIGV4_REGION`/`S3_SIGV4_SERVICE`, and the `CLOUD_LIMITS` ceilings for
  every quoted number.

`test/developer-docs.test.js` (21 cases) enforces the contract:

- llms.txt/llms-full.txt mention every catalog route and **no invented
  endpoint** — path-shaped tokens are extracted from backticks, links, and
  code fences (prose slashes are never collected) and checked against the
  catalog plus a structural whitelist for concrete examples
  (`/api/db/notes` for `/api/db/{collection}`).
- telegraph.json capability flags, scopes, TTLs, limits, and endpoints are
  deep-checked against the implementation constants.
- every `/docs` slug renders with full navigation; unknown slugs fail closed
  (404) and fall back to static-asset serving (`env.ASSETS`) when present,
  preserving pre-existing `/docs/*.md` files.
- `/admin` still 302-redirects into `/console` (canonical), `no-store`.
- **No secrets**: served bodies and the content module itself never contain
  credential-shaped values (`tg_live_…`/`tgsk_live_…` with random tails),
  pepper or bot-token assignments, private-key blocks, or the JWK private
  member `d`.

## Compatibility

- `/console` remains the canonical surface and is linked from every page;
  `/admin` remains the compatibility redirect (asserted by test).
- OpenAPI is unchanged in path coverage (already accuracy-tested); its
  `x-service` links now point at real endpoints.
- Static files under the repository `docs/` folder keep serving via the
  `ASSETS` fallback for paths the documentation pages do not claim.
- Console links (`renderApiDocs`) now all resolve; no console JS changes.

## Tests

Full suite: **581 passing / 0 failing** (phase 14 ended at 560; the delta is
the 21 new documentation tests).
