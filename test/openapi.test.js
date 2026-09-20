const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

const root = path.join(__dirname, '..');
function readRepoFile(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('OpenAPI document generation', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      openapi: await import('../functions/cloud/openapi.js'),
      globalRoute: await import('../functions/openapi.json.js'),
      projectRoute: await import('../functions/api/projects/[id]/openapi.json.js'),
      index: await import('../functions/cloud/index-store.js'),
      project: await import('../functions/cloud/project-registry.js'),
      db: await import('../functions/cloud/document-database.js'),
      projectsMiddleware: await import('../functions/api/projects/_middleware.js'),
    };
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function fixedClock() {
    return new Date('2026-09-20T09:00:00.000Z');
  }
  function createJournal() {
    const entries = [];
    return {
      entries,
      validateConfig() {},
      async appendJson(payload) {
        entries.push(JSON.parse(JSON.stringify(payload)));
        return { provider: 'telegram-journal', fileId: `journal_${entries.length}`, messageId: entries.length };
      },
    };
  }

  async function callGlobalRoute(origin) {
    const context = makeContext({ request: new Request(`${origin}/openapi.json`), env: {} });
    const res = await modules.globalRoute.onRequest(context);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /openapi\+json/);
    return res.json();
  }

  it('serves a valid 3.1 document rooted at the request origin', async function () {
    const doc = await callGlobalRoute('https://host.example');
    assert.strictEqual(doc.openapi, '3.1.0');
    assert.strictEqual(doc.info.title, 'Telegraph Cloud API');
    assert.deepStrictEqual(doc.servers, [{ url: 'https://host.example', description: 'This deployment.' }]);
    assert.ok(doc.paths['/api/db/{collection}']);
    assert.ok(doc.paths['/api/storage/{bucket}/{key}']);
    assert.ok(doc.components.securitySchemes.bearerApi);
    assert.ok(doc.components.securitySchemes.awsSigV4);
  });

  it('documents only routes that exist in the repository (no invented endpoints)', async function () {
    const doc = await callGlobalRoute('https://host.example');
    // Every documented path must map to a real function file.
    const mapping = {
      '/api/db/{collection}': 'functions/api/db/[collection]/index.js',
      '/api/db/{collection}/{recordId}': 'functions/api/db/[collection]/[id].js',
      '/api/storage/{bucket}': 'functions/api/storage/[bucket]/[[key]].js',
      '/api/storage/{bucket}/{key}': 'functions/api/storage/[bucket]/[[key]].js',
      '/s3/{bucket}': 'functions/s3/[[path]].js',
      '/s3/{bucket}/{key}': 'functions/s3/[[path]].js',
      '/api/health': 'functions/api/health.js',
      '/openapi.json': 'functions/openapi.json.js',
    };
    for (const [openapiPath, file] of Object.entries(mapping)) {
      assert.ok(doc.paths[openapiPath], `documented path missing: ${openapiPath}`);
      assert.ok(fs.existsSync(path.join(root, file)), `route file missing for ${openapiPath}: ${file}`);
    }
    // Every documented method must actually be handled by the mapped route.
    const methodEvidence = {
      'functions/api/db/[collection]/index.js': { get: "request.method === 'GET'", post: "request.method === 'POST'" },
      'functions/api/db/[collection]/[id].js': { get: "request.method === 'GET'", patch: "request.method === 'PATCH'", delete: "request.method === 'DELETE'" },
      'functions/api/health.js': { get: 'onRequest' },
      'functions/openapi.json.js': { get: 'onRequest' },
    };
    for (const [openapiPath, file] of Object.entries(mapping)) {
      if (!methodEvidence[file]) continue;
      const source = readRepoFile(file);
      for (const method of Object.keys(doc.paths[openapiPath])) {
        const needle = methodEvidence[file][method];
        assert.ok(needle && source.includes(needle), `${file} must handle ${method.toUpperCase()} for ${openapiPath}`);
      }
    }
    // The S3 catch-all protocol layer must implement the documented verbs.
    const s3Protocol = readRepoFile('functions/cloud/s3-protocol.js');
    for (const verb of ['getObject', 'headObject', 'putObject', 'deleteObject', 'listObjectsV2']) {
      assert.ok(s3Protocol.includes(verb), `S3 protocol must implement ${verb}`);
    }
    // The documented set must be complete: no undocumented data-plane function.
    const expectedPaths = new Set(Object.keys(mapping));
    assert.deepStrictEqual(new Set(Object.keys(doc.paths)), expectedPaths);
  });

  it('applies the correct authentication and scope per operation', async function () {
    const doc = await callGlobalRoute('https://host.example');
    assert.deepStrictEqual(doc.paths['/api/db/{collection}'].get.security, [{ bearerApi: ['db:read'] }]);
    assert.deepStrictEqual(doc.paths['/api/db/{collection}'].post.security, [{ bearerApi: ['db:write'] }]);
    assert.deepStrictEqual(doc.paths['/api/db/{collection}/{recordId}'].delete.security, [{ bearerApi: ['db:write'] }]);
    assert.deepStrictEqual(doc.paths['/api/storage/{bucket}/{key}'].put.security, [{ bearerApi: ['storage:write'] }]);
    assert.deepStrictEqual(doc.paths['/api/storage/{bucket}'].get.security, [{ bearerApi: ['storage:read'] }]);
    assert.deepStrictEqual(doc.paths['/s3/{bucket}'].get.security, [{ awsSigV4: [] }]);
    // Public platform endpoints carry no security requirement.
    assert.deepStrictEqual(doc.paths['/api/health'].get.security, []);
    assert.deepStrictEqual(doc.paths['/openapi.json'].get.security, []);
  });

  it('documents pagination, optimistic preconditions, and error codes honestly', async function () {
    const doc = await callGlobalRoute('https://host.example');
    const listParams = doc.paths['/api/db/{collection}'].get.parameters.map((p) => p.name);
    assert.ok(listParams.includes('limit') && listParams.includes('cursor'));
    const patchSchema = doc.paths['/api/db/{collection}/{recordId}'].patch.requestBody.content['application/json'].schema;
    assert.ok(patchSchema.required.includes('_expected_version'));
    assert.ok(doc.paths['/api/db/{collection}/{recordId}'].patch.responses['409']);
    assert.ok(doc.paths['/api/db/{collection}'].post.responses['201']);
    // Honest product statements.
    assert.match(doc.info.description, /NOT PostgreSQL/);
    assert.match(doc.info.description, /Multipart uploads, presigned URLs, and bucket policies are not implemented/);
  });

  describe('project-aware document', function () {
    async function fixture() {
      const kv = createMockKV();
      const env = { TELEGRAPH_CLOUD_KV: kv };
      const index = modules.index.createCloudIndexStore(env);
      const journal = createJournal();
      const projects = modules.project.createProjectRegistry(env, { index, now: fixedClock });
      const project = await projects.createProject({ slug: 'portfolio', name: 'Portfolio' });
      let id = 0;
      const database = modules.db.createTelegramDocumentDatabase(env, {
        index,
        journal,
        projectId: project.project_id,
        createId(prefix) {
          id += 1;
          return `${prefix}${String(id).padStart(22, '0')}`;
        },
        now: fixedClock,
      });
      return { env, projects, project, database };
    }

    it('includes the project collections and schema-derived example bodies', async function () {
      const { env, projects, project, database } = await fixture();
      await database.createCollection({
        name: 'products',
        description: 'Catalog',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'number', required: true },
          { name: 'published', type: 'boolean', required: false, default: false },
          { name: 'tag', type: 'select', required: false, options: ['new', 'sale'] },
        ],
      });
      await database.createCollection({ name: 'legacy', fields: [] });

      const context = makeContext({
        request: new Request('https://console.example/api/projects/x/openapi.json'),
        env,
        params: { id: project.project_id },
        data: { projectDatabase: database, projectRegistry: projects },
      });
      const res = await modules.projectsMiddleware.projectErrorHandling({
        ...context,
        next: () => modules.projectRoute.onRequest(context),
      });
      assert.strictEqual(res.status, 200);
      const doc = await res.json();
      assert.strictEqual(doc['x-project'].project_id, project.project_id);
      const names = doc['x-collections'].map((c) => c.name).sort();
      assert.deepStrictEqual(names, ['legacy', 'products']);
      const products = doc['x-collections'].find((c) => c.name === 'products');
      assert.strictEqual(products.has_schema, true);
      const legacy = doc['x-collections'].find((c) => c.name === 'legacy');
      assert.strictEqual(legacy.has_schema, false);

      const postExample = doc.paths['/api/db/{collection}'].post.requestBody.content['application/json'].examples.products.value;
      assert.deepStrictEqual(postExample, { name: 'text', price: 0, published: false, tag: 'new' });
      const patchExample = doc.paths['/api/db/{collection}/{recordId}'].patch.requestBody.content['application/json'].examples.products.value;
      assert.deepStrictEqual(patchExample, { name: 'text', price: 0, _expected_version: 1 });
    });

    it('fails closed without a dashboard session', async function () {
      const { env, projects, project, database } = await fixture();
      const context = makeContext({
        request: new Request('https://console.example/api/projects/x/openapi.json'),
        env: { ...env, BASIC_USER: 'admin', BASIC_PASS: 'secret' },
        params: { id: project.project_id },
        data: { projectDatabase: database, projectRegistry: projects },
      });
      const res = await modules.projectsMiddleware.projectAuthentication(context);
      assert.strictEqual(res.status, 401);
    });
  });
});
