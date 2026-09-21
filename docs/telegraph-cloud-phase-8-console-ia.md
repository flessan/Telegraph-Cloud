# Telegraph Cloud — Phase 8: Console IA canonicalization

Phase 8 makes `/console` the single canonical management UI and fixes the
information architecture to the target structure, without redesigning the
backend and without removing any legacy API.

## Target information architecture (shipped)

```
Telegraph Cloud            (#/console)
- Overview                 #/overview
- Projects                 #/projects
- Documentation            #/docs
- Project                  #/project/:id/…
  - Overview               …/overview
  - Data                   …/data          (collections · records · schema)
  - Files                  …/files         (drive · objects · s3 + SigV4 credentials)
  - API                    …/api           (endpoints · keys · explorer · docs)
  - Connect                …/connect
  - Settings               …/settings      (project identity/status)
```

Console preferences (theme, language, compatibility links) are not a global
sidebar section. They live behind the topbar settings button; the
`#/settings` deep link continues to work for existing bookmarks.

## Audit findings at the start of the phase

- `/admin` already served a 302 to `/console` (`functions/admin.js`); the
  redirect is now pinned by a test.
- The project-level sections already used the canonical slugs
  (`overview | data | files | api | connect | settings`) with alias handling
  for pre-rework deep links.
- Deviations found and fixed in this phase:
  - The global sidebar still carried a fourth item, **Settings**.
  - Project overview tiles and quick actions still linked with pre-rework
    slugs (`drive`, `database`, `s3`, `keys`, `s3-credentials`).
  - The Files→S3 view had a vestigial "Manage S3 credentials" self-link
    (the credentials panel renders on the same tab since the rework).
  - Docs (README, console doc, in-console documentation view, e2e scripts)
    still described `/admin` as a live workspace.

## Changes

UI/navigation only (no backend or data-plane changes):

- Global sidebar is exactly **Overview, Projects, Documentation**.
- New topbar settings button (`#c-console-settings-btn`) opens the console
  preferences view (`#/settings`, still a valid deep link).
- Project overview quick links and resource tiles use canonical sections
  (`files?tab=drive`, `data`, `api?tab=keys`, `connect`, `settings`).
- Projects context-menu and S3 view links canonicalized; the vestigial
  S3 self-link button removed.
- In-console documentation, README, and `docs/telegraph-cloud-console.md`
  updated to describe the canonical entry points.

## Legacy compatibility preserved

- **`/admin`** → 302 `/console` (compatibility entry; asserted by
  `test/admin-redirect.test.js`).
- **`/admin-legacy`** (pretty URL for `admin-legacy.html`) keeps the entire
  legacy media workspace: staging, push queue, albums, whitelist/blacklist,
  moderation, short links, remote management. Linked from the console sidebar
  footer as **Legacy Media**.
- **Pre-rework console deep links** keep working via the router alias table:
  `drive` → `files?tab=drive`, `database` → `data?tab=collections`,
  `s3` → `files?tab=s3`, `s3-credentials` → `files?tab=s3`,
  `keys` → `api?tab=keys` (asserted by `test/admin-redirect.test.js`).
- **No legacy API route was removed or changed**: `/api/manage/*`,
  `/api/db/*`, `/api/storage/*`, `/api/projects/*`, `/s3/*`, `/p/*`,
  `/file/*`, `/upload`, moderation, config, health, and OpenAPI surfaces are
  untouched.
- `#/settings` remains a working deep link.
- The optional Playwright e2e scripts were retargeted from the dead
  `/admin` links to `/admin-legacy` so they keep exercising the legacy flows
  they were written for; `test/e2e/homepage.js` now also asserts the landing
  links to `/console`.

## Tests

- `test/admin-redirect.test.js` (new): `/admin` 302 + empty body +
  `Cache-Control: no-store`; router alias table maps every legacy slug to its
  canonical section and default tab.
- `test/console-dom.test.js`: the global nav must be exactly
  Overview/Projects/Documentation; the project nav must be the six canonical
  sections in order; canonical and legacy deep links must render.
- Full suite: `npm test` (mocha) — all tests pass after the rework.
