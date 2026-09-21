// API section: Endpoints (the actual API surface), API Keys (developer Bearer
// keys), Explorer (per-collection request builder), and Documentation links.
import { h, clear } from '../util.js';
import { api } from '../api.js';
import { pageHead } from '../ui.js';
import { ct } from '../i18n.js';
import { subTabs, copyButton } from './common.js';
import { renderApiKeys } from './api-keys.js';
import { renderExplorer } from './explorer.js';

export async function renderApi(container, projectId, query) {
  const tab = ['endpoints', 'keys', 'explorer', 'docs'].includes(query.get('tab')) ? query.get('tab') : 'endpoints';

  container.append(pageHead(ct('API'), ct('The REST API, developer API keys, and the explorer. Developer keys are Bearer-only and scoped; S3 uses separate SigV4 credentials.')));
  container.append(subTabs(projectId, 'api', tab, [
    { tab: 'endpoints', label: () => ct('Endpoints') },
    { tab: 'keys', label: () => ct('API Keys') },
    { tab: 'explorer', label: () => ct('Explorer') },
    { tab: 'docs', label: () => ct('Documentation') },
  ]));

  const body = h('div', {});
  container.append(body);

  if (tab === 'endpoints') renderEndpoints(body, projectId);
  else if (tab === 'keys') await renderApiKeys(body, projectId);
  else if (tab === 'explorer') await renderExplorer(body, projectId, query);
  else renderApiDocs(body, projectId);
}

// ------------------------------------------------------------ endpoints
// The catalog lists only endpoints that actually exist in this deployment.
// Paths shown for developers; the console itself calls the equivalent
// dashboard-session project routes.
function renderEndpoints(wrap, projectId) {
  const rows = [
    ['GET', '/api/db/{collection}', 'Bearer · db:read', ct('List documents (limit, cursor, exact-match filters)')],
    ['POST', '/api/db/{collection}', 'Bearer · db:write', ct('Create a document (JSON body, optional Idempotency-Key)')],
    ['GET', '/api/db/{collection}/{id}', 'Bearer · db:read', ct('Read one document with its version')],
    ['PATCH', '/api/db/{collection}/{id}', 'Bearer · db:write', ct('Update a document (requires _expected_version)')],
    ['DELETE', '/api/db/{collection}/{id}', 'Bearer · db:write', ct('Delete a document (requires _expected_version)')],
    ['GET', '/api/db/{collection}/{id}/history', 'Bearer · db:read', ct('Immutable revision history')],
    ['PUT', '/api/storage/{bucket}/{key}', 'Bearer · storage:write', ct('Upload an object (same engine as Drive and S3)')],
    ['GET', '/api/storage/{bucket}/{key}', 'Bearer · storage:read', ct('Download an object (ranges and conditions supported)')],
    ['HEAD', '/api/storage/{bucket}/{key}', 'Bearer · storage:read', ct('Object metadata without the body')],
    ['DELETE', '/api/storage/{bucket}/{key}', 'Bearer · storage:write', ct('Delete an object')],
    ['GET', '/api/storage/{bucket}', 'Bearer · storage:read', ct('List objects (prefix, delimiter, cursor)')],
    ['GET', '/s3/{bucket}[/{key}]', 'SigV4', ct('S3 GetObject / HeadObject / ListObjectsV2 (path style)')],
    ['PUT', '/s3/{bucket}/{key}', 'SigV4', ct('S3 PutObject')],
    ['DELETE', '/s3/{bucket}/{key}', 'SigV4', ct('S3 DeleteObject')],
    ['GET', '/api/health', 'Public', ct('Deployment health signal')],
    ['GET', '/openapi.json', 'Public', ct('Machine-readable API description')],
    ['POST', '/api/auth/token', 'Bearer · key or JWT', ct('Exchange an API key or unexpired JWT for a short-lived ES256 JWT (60–3600 s)')],
    ['GET', '/.well-known/jwks.json', 'Public', ct('Public JWT verification keys (rotation-aware)')],
    ['POST', '/api/auth/keys/rotate', 'Dashboard', ct('Rotate JWT signing keys; outstanding tokens keep verifying')],
    ['GET', '/llms.txt · /llms-full.txt · /docs/ai', 'Public', ct('AI-agent documentation')],
    ['GET', '/.well-known/telegraph.json', 'Public', ct('Service metadata')],
  ];

  const table = h('table', { class: 'c-table' }, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, ct('Method')), h('th', {}, ct('Path')), h('th', {}, ct('Authentication')), h('th', {}, ct('Description')),
    ])),
    h('tbody', {}, rows.map(([method, path, auth, description]) => h('tr', {}, [
      h('td', {}, methodBadge(method)),
      h('td', {}, h('code', { style: { wordBreak: 'break-all' } }, path)),
      h('td', {}, h('span', { class: 'c-badge' }, auth)),
      h('td', { class: 'c-cell-sub' }, description),
    ]))),
  ]);
  wrap.append(h('p', { style: { margin: '0 0 12px', color: 'var(--c-text-2)', fontSize: '13px' } },
    ct('Only endpoints implemented in this deployment are listed. S3 multipart uploads, presigned URLs, and bucket policies are not implemented and are documented as deferred.')));
  wrap.append(h('div', { class: 'c-table-wrap' }, table));

  // Per-collection endpoints for this project's actual collections.
  const collWrap = h('div', { style: { marginTop: '16px' } });
  wrap.append(collWrap);
  api.get(`/api/projects/${encodeURIComponent(projectId)}/db/collections?maxKeys=100`).then((page) => {
    const collections = page.data || [];
    clear(collWrap);
    if (!collections.length) return;
    collWrap.append(h('h3', { style: { fontSize: '14px', margin: '0 0 8px' } }, ct('Endpoints for this project')));
    const rows2 = collections.map((collection) => [
      `GET · POST /api/db/${collection.name} · GET · PATCH · DELETE /api/db/${collection.name}/{id}`,
      collection.fields?.length ? ct('{n} schema fields', { n: collection.fields.length }) : ct('Schema-less'),
    ]);
    const table2 = h('table', { class: 'c-table' }, [
      h('thead', {}, h('tr', {}, [h('th', {}, ct('Collection')), h('th', {}, ct('Schema'))])),
      h('tbody', {}, collections.map((collection, index) => h('tr', {}, [
        h('td', {}, h('code', {}, collection.name)),
        h('td', { class: 'c-cell-sub' }, rows2[index][1]),
      ]))),
    ]);
    collWrap.append(h('div', { class: 'c-table-wrap' }, table2));
  }).catch(() => { /* collection discovery is best-effort in this tab */ });
}

function methodBadge(method) {
  const color = { GET: 'active', POST: '', PATCH: '', DELETE: 'warn' }[method] || '';
  return h('span', { class: `c-badge ${color}`, style: { fontFamily: 'var(--c-font-mono, monospace)' } }, method);
}

// ----------------------------------------------------------------- docs
function renderApiDocs(wrap, projectId) {
  const origin = window.location.origin;
  const enc = encodeURIComponent(projectId);
  const links = [
    [`${origin}/openapi.json`, ct('OpenAPI 3.1 description of the API surface (generated, no invented endpoints)')],
    [`${origin}/api/projects/${enc}/openapi.json`, ct('Project-aware OpenAPI document including this project’s collections')],
    [`${origin}/llms.txt`, ct('Concise machine-readable digest for AI agents')],
    [`${origin}/llms-full.txt`, ct('Full machine-readable documentation')],
    [`${origin}/docs/ai`, ct('AI-agent integration guide (human + machine readable)')],
    [`${origin}/docs/ai-agent`, ct('Copy-ready AI agent onboarding page')],
    [`${origin}/.well-known/jwks.json`, ct('Public JWT verification keys (JWKS)')],
    [`${origin}/.well-known/telegraph.json`, ct('Service metadata for discovery')],
  ];
  for (const [url, description] of links) {
    wrap.append(h('div', { class: 'c-card', style: { padding: '12px 16px', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, [
      h('a', { href: url, style: { color: 'var(--c-primary)', fontWeight: '600', fontSize: '13px', wordBreak: 'break-all', flex: '1 1 320px' } }, url.replace(origin, '')),
      h('span', { style: { color: 'var(--c-text-2)', fontSize: '12.5px', flex: '1 1 220px' } }, description),
      copyButton(url, { label: '' }),
    ]));
  }
  wrap.append(h('div', { class: 'c-alert', style: { marginTop: '12px' } }, [
    h('p', {}, ct('Authentication: developer Bearer keys (tg_live_…) with scopes, and optional short-lived JWTs verified against the JWKS endpoint. S3 uses separate SigV4 credentials. The dashboard session is never a developer credential.')),
  ]));
}
