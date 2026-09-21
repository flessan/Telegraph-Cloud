const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeContext, muteConsole } = require('./helpers');

// The documentation surface must tell the truth: every endpoint mentioned
// must exist in the OpenAPI catalog (or the explicit auth/rotation allow
// list), every fact must come from implementation constants, and no secret
// material may appear anywhere in a served body.
const ORIGIN = 'https://docs.example';
const ROOT = path.join(__dirname, '..');

function requestFor(pathname) {
  return new Request(`${ORIGIN}${pathname}`);
}

function docsContext(pathname, { params } = {}) {
  return makeContext({
    request: requestFor(pathname),
    params: params === undefined ? { page: pathname.replace('/docs/', '') } : params,
  });
}

async function body(response) {
  return response.text();
}

// Every route-like token in doc text must be one of these. Anything else is
// an invented endpoint and fails the test.
const ALLOWED_PATHS = new Set([
  // OpenAPI developer data plane (kept in sync with the catalog via the
  // cross-check in 'llms.txt lists exactly the real data plane').
  '/api/db',
  '/api/db/{collection}',
  '/api/db/{collection}/{recordId}',
  '/api/storage',
  '/api/storage/{bucket}',
  '/api/storage/{bucket}/{key}',
  '/s3',
  '/s3/{bucket}',
  '/s3/{bucket}/{key}',
  '/api/health',
  '/openapi.json',
  '/api/auth/token',
  '/.well-known/jwks.json',
  '/.well-known/telegraph.json',
  '/api/auth/keys/rotate',
  '/api/projects/{id}/db/collections',
  '/docs',
  '/console',
  '/admin',
  '/admin.html',
  '/llms.txt',
  '/llms-full.txt',
]);

// Route-shaped tokens only ever appear in backticked code spans, markdown
// link targets, HTML href attributes, or fenced code examples — prose slashes
// ("ranges/conditions") are not endpoints and are never collected. Fences are
// segmented first so triple-backticks cannot pair across a code block.
const PATH_PREFIXES = ['/api', '/s3', '/.well-known', '/openapi', '/llms', '/docs', '/console', '/admin'];
const PATH_TOKEN = /\/[A-Za-z0-9._{}\-]+(?:\/[A-Za-z0-9._{}\-[\]]+)*/g;

function extractPaths(text) {
  const stripped = text.split(ORIGIN).join('');
  const candidates = [];
  const pushAll = (value) => {
    for (const match of value.match(PATH_TOKEN) || []) {
      candidates.push(match.replace(/[).,;'"\]]+$/g, ''));
    }
  };
  const segments = stripped.split('```');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index % 2 === 1) {
      // Fenced code example: scan the code itself.
      pushAll(segment);
      continue;
    }
    for (const span of segment.match(/`([^`]+)`/g) || []) pushAll(span);
    for (const link of segment.match(/\]\(([^)\s]+)\)/g) || []) pushAll(link);
    for (const href of segment.match(/href="([^"]+)"/g) || []) pushAll(href);
  }
  return candidates.filter((value) => PATH_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}.`)));
}

// Concrete examples in the docs instantiate the templated routes (e.g.
// /api/db/notes for /api/db/{collection}). Structure, not literal text,
// decides whether a mentioned path is real.
function isRealPath(value) {
  if (ALLOWED_PATHS.has(value)) return true;
  const generics = [
    /^\/api\/db\/[^/]+$/,
    /^\/api\/db\/[^/]+\/[^/]+$/,
    /^\/api\/storage\/[^/]+$/,
    /^\/api\/storage\/[^/]+\/.+$/,
    /^\/s3\/[^/]+$/,
    /^\/s3\/[^/]+\/.+$/,
    /^\/api\/projects\/[^/]+\/db\/collections$/,
    /^\/docs\/[a-z-]+$/,
  ];
  return generics.some((pattern) => pattern.test(value));
}

describe('Telegraph Cloud developer documentation surface', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      docs: await import('../functions/cloud/developer-docs.js'),
      openapi: await import('../functions/cloud/openapi.js'),
      llmsRoute: await import('../functions/llms.txt.js'),
      llmsFullRoute: await import('../functions/llms-full.txt.js'),
      telegraphRoute: await import('../functions/.well-known/telegraph.json.js'),
      docsRoute: await import('../functions/docs/[[page]].js'),
      adminRoute: await import('../functions/admin.js'),
      jwt: await import('../functions/cloud/jwt-auth.js'),
      apiKeys: await import('../functions/cloud/developer-api-keys.js'),
      s3sigv4: await import('../functions/cloud/s3-sigv4.js'),
    };
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  describe('llms.txt', function () {
    it('serves a public, cacheable plain-text digest rooted at the origin', async function () {
      const response = await modules.llmsRoute.onRequestGet(docsContext('/llms.txt', { params: {} }));
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /text\/plain/);
      assert.match(response.headers.get('Cache-Control'), /public/);
      const text = await body(response);
      assert.ok(text.includes(`Base URL: ${ORIGIN}`));
      assert.ok(text.startsWith('# Telegraph Cloud'));
    });

    it('lists exactly the real data plane (no invented endpoints)', async function () {
      const response = await modules.llmsRoute.onRequestGet(docsContext('/llms.txt', { params: {} }));
      const text = await body(response);
      for (const route of modules.openapi.DATA_PLANE) {
        assert.ok(text.includes(route.path), `catalog path missing from llms.txt: ${route.path}`);
      }
      const mentioned = extractPaths(text);
      const invented = mentioned.filter((value) => !isRealPath(value));
      assert.deepStrictEqual(invented, [], `invented endpoints in llms.txt: ${invented.join(', ')}`);
    });

    it('quotes implementation constants for auth, TTLs, and audience', async function () {
      const response = await modules.llmsRoute.onRequestGet(docsContext('/llms.txt', { params: {} }));
      const text = await body(response);
      for (const scope of modules.apiKeys.API_KEY_SCOPES) {
        assert.ok(text.includes(scope), `scope missing: ${scope}`);
      }
      assert.ok(text.includes(`aud (\`${modules.jwt.JWT_AUDIENCE}\`)`));
      assert.ok(text.includes(`${modules.jwt.JWT_TTL.default} s`));
      assert.ok(text.includes(`${modules.jwt.JWT_TTL.min}–${modules.jwt.JWT_TTL.max} s`));
      assert.ok(text.includes(modules.s3sigv4.S3_SIGV4_REGION || 'us-east-1'));
    });
  });

  describe('llms-full.txt', function () {
    it('is a superset: the digest plus every documentation topic', async function () {
      const digest = await body(await modules.llmsRoute.onRequestGet(docsContext('/llms.txt', { params: {} })));
      const full = await body(await modules.llmsFullRoute.onRequestGet(docsContext('/llms-full.txt', { params: {} })));
      assert.ok(full.length > digest.length, 'llms-full must be longer than the digest');
      assert.ok(digest.split('\n').length < full.split('\n').length);
      for (const page of modules.docs.DOC_PAGES) {
        assert.ok(full.includes(`# ${page.title}`), `topic missing: ${page.title}`);
      }
      // The full document contains the working curl examples.
      assert.ok(full.includes('curl -s -X POST "$TELEGRAPH_URL/api/db/notes"'));
      assert.ok(full.includes('$TELEGRAPH_URL/.well-known/jwks.json'));
    });

    it('mentions no invented endpoints either', async function () {
      const full = await body(await modules.llmsFullRoute.onRequestGet(docsContext('/llms-full.txt', { params: {} })));
      const invented = extractPaths(full).filter((value) => !isRealPath(value));
      assert.deepStrictEqual(invented, [], `invented endpoints in llms-full.txt: ${invented.join(', ')}`);
    });

    it('uses the same Content-Type and cache policy as the digest', async function () {
      const response = await modules.llmsFullRoute.onRequestGet(docsContext('/llms-full.txt', { params: {} }));
      assert.match(response.headers.get('Content-Type'), /text\/plain/);
      assert.match(response.headers.get('Cache-Control'), /public/);
    });
  });

  describe('/.well-known/telegraph.json', function () {
    it('serves service metadata with origin-rooted endpoints', async function () {
      const response = await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }));
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      assert.match(response.headers.get('Cache-Control'), /public/);
      const document = JSON.parse(await body(response));
      assert.strictEqual(document.schema, 'telegraph-cloud.service.v1');
      assert.strictEqual(document.name, 'Telegraph Cloud');
      assert.strictEqual(document.console, `${ORIGIN}/console`);
      assert.strictEqual(document.compatibility.admin_entry, `${ORIGIN}/admin`);
      assert.strictEqual(document.compatibility.admin_redirects_to_console, true);
      assert.strictEqual(document.endpoints.openapi, `${ORIGIN}/openapi.json`);
      assert.strictEqual(document.endpoints.jwks, `${ORIGIN}/.well-known/jwks.json`);
      assert.strictEqual(document.endpoints.docs, `${ORIGIN}/docs`);
      assert.strictEqual(document.endpoints.llms, `${ORIGIN}/llms.txt`);
      assert.strictEqual(document.endpoints.llms_full, `${ORIGIN}/llms-full.txt`);
    });

    it('reports capabilities honestly (true only where implemented)', async function () {
      const document = JSON.parse(await body(await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }))));
      assert.strictEqual(document.capabilities.document_database, true);
      assert.strictEqual(document.capabilities.object_storage, true);
      assert.strictEqual(document.capabilities.s3_endpoint, true);
      assert.strictEqual(document.capabilities.jwt_authentication, true);
      assert.strictEqual(document.capabilities.sql, false);
      assert.strictEqual(document.capabilities.sql_wire_protocol, false);
      assert.strictEqual(document.capabilities.orm_compatibility, false);
      assert.strictEqual(document.capabilities.s3_multipart_upload, false);
      assert.strictEqual(document.capabilities.s3_presigned_urls, false);
      assert.strictEqual(document.capabilities.s3_bucket_policies, false);
    });

    it('derives auth and limits from implementation constants', async function () {
      const document = JSON.parse(await body(await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }))));
      assert.deepStrictEqual([...document.auth.bearer.scopes], [...modules.apiKeys.API_KEY_SCOPES]);
      assert.strictEqual(document.auth.bearer.jwt.audience, modules.jwt.JWT_AUDIENCE);
      assert.strictEqual(document.auth.bearer.jwt.ttl_default_seconds, modules.jwt.JWT_TTL.default);
      assert.strictEqual(document.auth.bearer.jwt.ttl_min_seconds, modules.jwt.JWT_TTL.min);
      assert.strictEqual(document.auth.bearer.jwt.ttl_max_seconds, modules.jwt.JWT_TTL.max);
      assert.strictEqual(document.auth.bearer.jwt.issuer_env, 'TELEGRAPH_CLOUD_JWT_ISSUER');
      assert.strictEqual(document.auth.bearer.jwt.issuer_default, ORIGIN);
      assert.strictEqual(document.auth.s3.region, 'us-east-1');
      assert.strictEqual(document.auth.s3.service, 's3');
      const { CLOUD_LIMITS } = await import('../functions/cloud/validation.js');
      assert.strictEqual(document.limits.document_bytes, CLOUD_LIMITS.DEFAULT_DOCUMENT_DATABASE_MAX_BYTES);
      assert.strictEqual(document.limits.object_bytes, CLOUD_LIMITS.MAX_OBJECT_BYTES);
      assert.strictEqual(document.limits.mutations_per_minute_per_project, 20);
    });
  });

  describe('/docs pages', function () {
    it('serves every authored page as HTML with navigation', async function () {
      for (const page of modules.docs.DOC_PAGES) {
        const response = await modules.docsRoute.onRequestGet(docsContext(`/docs/${page.slug}`));
        assert.strictEqual(response.status, 200, page.slug);
        assert.match(response.headers.get('Content-Type'), /text\/html/);
        const html = await body(response);
        const escapedTitle = page.title.replace(/&/g, '&amp;');
        assert.ok(html.includes(page.title) || html.includes(escapedTitle), `title missing on ${page.slug}`);
        for (const nav of modules.docs.DOC_PAGES) {
          assert.ok(html.includes(`href="/docs/${nav.slug}"`), `nav link missing on ${page.slug}: ${nav.slug}`);
        }
        assert.ok(html.includes(`${ORIGIN}/console`), `console link missing on ${page.slug}`);
        assert.ok(!html.includes('<script'), `no scripts expected on ${page.slug}`);
      }
    });

    it('serves /docs (landing) as the getting-started page', async function () {
      const response = await modules.docsRoute.onRequestGet(docsContext('/docs', { params: { page: '' } }));
      assert.strictEqual(response.status, 200);
      const html = await body(response);
      assert.ok(html.includes('Getting started'));
      assert.ok(html.includes('id="1-open-the-console"'));
    });

    it('keeps /docs/ai and the copy-ready /docs/ai-agent brief working', async function () {
      const ai = await modules.docsRoute.onRequestGet(docsContext('/docs/ai'));
      assert.strictEqual(ai.status, 200);
      const aiHtml = await body(ai);
      assert.ok(aiHtml.includes('Direct integration instructions'));
      assert.ok(aiHtml.includes(`${ORIGIN}/llms.txt`));

      const brief = await modules.docsRoute.onRequestGet(docsContext('/docs/ai-agent'));
      assert.strictEqual(brief.status, 200);
      assert.match(brief.headers.get('Content-Type'), /text\/markdown/);
      const briefText = await body(brief);
      assert.ok(briefText.includes(`TELEGRAPH_URL=${ORIGIN}`));
      assert.ok(briefText.includes('tg_live_YOUR_KEY'));
      assert.ok(briefText.includes('Never commit secrets'));
    });

    it('fails closed (404) on unknown pages without an ASSETS binding', async function () {
      const response = await modules.docsRoute.onRequestGet(docsContext('/docs/none'));
      assert.strictEqual(response.status, 404);
    });

    it('falls back to static-asset serving for unknown paths when ASSETS exists', async function () {
      const fallback = new Response('static', { status: 200 });
      const context = makeContext({
        request: requestFor('/docs/telegraph-cloud-phase-14-jwt-authentication.md'),
        params: { page: 'telegraph-cloud-phase-14-jwt-authentication.md' },
        env: { ASSETS: { fetch: async (request) => (request.url === `${ORIGIN}/docs/telegraph-cloud-phase-14-jwt-authentication.md` ? fallback : new Response(null, { status: 404 })) } },
      });
      const response = await modules.docsRoute.onRequestGet(context);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await body(response), 'static');
    });

    it('rejects non-GET/HEAD methods', async function () {
      const response = modules.docsRoute.onRequest
        ? await modules.docsRoute.onRequest({ ...docsContext('/docs'), request: new Request(`${ORIGIN}/docs`, { method: 'POST' }), params: { page: '' } })
        : null;
      assert.ok(response, 'onRequest must exist');
      assert.strictEqual(response.status, 405);
    });
  });

  describe('console-canonical and admin compatibility', function () {
    it('/admin remains a redirect into /console', async function () {
      const response = modules.adminRoute.onRequest({});
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.get('Location'), '/console');
      assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');
    });

    it('documentation points at /console as the canonical surface', async function () {
      const document = JSON.parse(await body(await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }))));
      assert.ok(document.console.endsWith('/console'));
      const html = await body(await modules.docsRoute.onRequestGet(docsContext('/docs/getting-started')));
      assert.ok(html.includes('canonical'));
      assert.ok(html.includes('/admin'));
    });
  });

  describe('no secrets anywhere on the documentation surface', function () {
    it('served bodies never contain credential-shaped values', async function () {
      const bodies = [
        await body(await modules.llmsRoute.onRequestGet(docsContext('/llms.txt', { params: {} }))),
        await body(await modules.llmsFullRoute.onRequestGet(docsContext('/llms-full.txt', { params: {} }))),
        await body(await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }))),
        await body(await modules.docsRoute.onRequestGet(docsContext('/docs/ai-agent'))),
        await body(await modules.docsRoute.onRequestGet(docsContext('/docs/self-hosting'))),
        await body(await modules.docsRoute.onRequestGet(docsContext('/docs/api-keys'))),
      ];
      for (const text of bodies) {
        assert.ok(!/tg_live_[A-Za-z0-9]{20,}/.test(text), 'real-looking API key in documentation');
        assert.ok(!/tgsk_live_[A-Za-z0-9]{20,}/.test(text), 'real-looking S3 access key id in documentation');
        assert.ok(!/PEPPER\s*=\s*\S+/.test(text), 'pepper value in documentation');
        assert.ok(!/TG_Bot_Token\s*[:=]\s*\S+/.test(text), 'bot token value in documentation');
        assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), 'private key block in documentation');
      }
      const telegraph = bodies[2];
      assert.ok(!/"d"\s*:/.test(telegraph), 'JWK private member in service metadata');
    });

    it('the docs content module itself ships no secret values', async function () {
      const source = fs.readFileSync(path.join(ROOT, 'functions', 'cloud', 'developer-docs.js'), 'utf8');
      assert.ok(!/dev-only-[a-z-]*pepper/.test(source), 'local dev pepper values must not leak into shipped docs');
      assert.ok(!/tg_live_[A-Za-z0-9]{20,}/.test(source));
    });
  });

  describe('documentation stays in lockstep with the route catalog', function () {
    it('every data-plane route appears in the shared endpoint table', function () {
      const rows = modules.docs.endpointRows();
      for (const route of modules.openapi.DATA_PLANE) {
        for (const method of route.methods) {
          assert.ok(
            rows.some((row) => row.path === route.path && row.method === method.toUpperCase()),
            `endpoint table missing ${method.toUpperCase()} ${route.path}`,
          );
        }
      }
      const rotate = rows.find((row) => row.path === '/api/auth/keys/rotate');
      assert.ok(rotate && /Dashboard/.test(rotate.auth), 'rotation route must be marked dashboard-gated');
    });

    it('describes the full OpenAPI document in telegraph.json endpoints', async function () {
      const doc = await modules.openapi.buildOpenApiDocument({ origin: ORIGIN });
      const document = JSON.parse(await body(await modules.telegraphRoute.onRequestGet(docsContext('/.well-known/telegraph.json', { params: {} }))));
      assert.strictEqual(document.endpoints.openapi, doc.servers[0].url + '/openapi.json');
    });
  });
});
