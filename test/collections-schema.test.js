const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

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

describe('Telegraph Cloud collection schemas and lifecycle', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      index: await import('../functions/cloud/index-store.js'),
      project: await import('../functions/cloud/project-registry.js'),
      db: await import('../functions/cloud/document-database.js'),
      schema: await import('../functions/cloud/collection-schema.js'),
      collectionNameRoute: await import('../functions/api/projects/[id]/db/collections/[name].js'),
      collectionsRoute: await import('../functions/api/projects/[id]/db/collections.js'),
      projectsMiddleware: await import('../functions/api/projects/_middleware.js'),
    };
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  // ------------------------------------------------------------- service level
  function createDatabase({ env: extraEnv = {}, projectId = null } = {}) {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv, ...extraEnv };
    const journal = createJournal();
    const index = modules.index.createCloudIndexStore(env);
    let id = 0;
    const database = modules.db.createTelegramDocumentDatabase(env, {
      index,
      journal,
      projectId,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
      now: fixedClock,
    });
    return { database, env, kv, journal };
  }

  const PRODUCTS_SCHEMA = {
    name: 'products',
    description: 'Product catalog',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'number', required: true },
      { name: 'published', type: 'boolean', required: false, default: false },
      { name: 'tags', type: 'select', required: false, options: ['new', 'sale'] },
    ],
  };

  describe('collection lifecycle', function () {
    it('creates, gets, patches, and deletes collections with schema metadata', async function () {
      const { database } = createDatabase();
      const created = await database.createCollection(PRODUCTS_SCHEMA);
      assert.strictEqual(created.status, 201);
      assert.strictEqual(created.body.schema, 'telegraph-cloud.collection.v1');
      assert.strictEqual(created.body.fields.length, 4);

      const fetched = await database.getCollection('products');
      assert.strictEqual(fetched.description, 'Product catalog');

      // Duplicate creation conflicts.
      await assert.rejects(database.createCollection(PRODUCTS_SCHEMA), (error) => error.code === 'collection_exists');

      // Unknown collection is a 404 with the documented code.
      await assert.rejects(database.getCollection('missing'), (error) => error.code === 'collection_not_found' && error.status === 404);
      await assert.rejects(database.patchCollection('missing', { description: 'x' }), (error) => error.code === 'collection_not_found');
      await assert.rejects(database.deleteCollection('missing'), (error) => error.code === 'collection_not_found');

      // Patch description and replace fields (schema migration surface).
      const patched = await database.patchCollection('products', {
        description: 'Updated catalog',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'sku', type: 'text', required: false },
        ],
      });
      assert.strictEqual(patched.description, 'Updated catalog');
      assert.deepStrictEqual(patched.fields.map((f) => f.name), ['name', 'sku']);

      // Deletion of an empty collection succeeds.
      const deleted = await database.deleteCollection('products');
      assert.deepStrictEqual(deleted, { deleted: true, name: 'products' });
      await assert.rejects(database.getCollection('products'), (error) => error.code === 'collection_not_found');
    });

    it('rejects invalid schema definitions, including defaults that violate the field type', async function () {
      const { database } = createDatabase();
      await assert.rejects(
        database.createCollection({ name: 'bad', fields: [{ name: 'n', type: 'nope' }] }),
        (error) => error.code === 'invalid_collection_field_type',
      );
      await assert.rejects(
        database.createCollection({ name: 'bad', fields: [{ name: 'version', type: 'text' }] }),
        (error) => error.code === 'invalid_collection_field',
      );
      await assert.rejects(
        database.createCollection({ name: 'bad', fields: [{ name: 'n', type: 'number', default: 'abc' }] }),
        (error) => error.code === 'invalid_collection_field_default',
      );
      await assert.rejects(
        database.patchCollection('bad', { unsupported: 1 }),
        (error) => error.code === 'invalid_collection_patch',
      );
    });

    it('refuses to delete a collection that still has records', async function () {
      const { database } = createDatabase();
      await database.createCollection({ name: 'logs', fields: [] });
      await database.createDocument('logs', { level: 'info' });
      await assert.rejects(database.deleteCollection('logs'), (error) => error.code === 'collection_not_empty' && error.status === 409);
    });

    it('lists legacy schema-less collections alongside schema-defined ones', async function () {
      const { database } = createDatabase();
      await database.createCollection(PRODUCTS_SCHEMA);
      // No metadata for "legacy_items": records only.
      await database.createDocument('legacy_items', { anything: 'goes' });
      const page = await database.listCollections();
      const names = page.data.map((c) => c.name).sort();
      assert.deepStrictEqual(names, ['legacy_items', 'products']);
      const legacy = page.data.find((c) => c.name === 'legacy_items');
      assert.strictEqual(legacy.fields.length, 0);
      assert.strictEqual(legacy.record_count, 1);
      const products = page.data.find((c) => c.name === 'products');
      assert.strictEqual(products.fields.length, 4);
      assert.strictEqual(products.record_count, 0);
    });
  });

  describe('schema enforcement on create', function () {
    it('accepts arbitrary JSON for legacy collections without metadata', async function () {
      const { database } = createDatabase();
      const result = await database.createDocument('freeform', { nested: { a: [1, 2, 3] }, n: 1.5 });
      assert.strictEqual(result.status, 201);
      assert.deepStrictEqual(result.body.data.nested, { a: [1, 2, 3] });
    });

    it('enforces required fields, types, select options, and allowed field names', async function () {
      const { database } = createDatabase();
      await database.createCollection(PRODUCTS_SCHEMA);

      // Missing required field.
      await assert.rejects(
        database.createDocument('products', { name: 'Aurora' }),
        (error) => error.code === 'schema_validation_failed' && /"price" is required/.test(error.message),
      );

      // Wrong type.
      await assert.rejects(
        database.createDocument('products', { name: 'Aurora', price: '19.90' }),
        (error) => error.code === 'schema_validation_failed' && /"price" must be a number/.test(error.message),
      );

      // Select value outside options.
      await assert.rejects(
        database.createDocument('products', { name: 'Aurora', price: 1, tags: 'clearance' }),
        (error) => error.code === 'schema_validation_failed' && /must be one of: new, sale/.test(error.message),
      );

      // Unknown field.
      await assert.rejects(
        database.createDocument('products', { name: 'Aurora', price: 1, surprise: true }),
        (error) => error.code === 'schema_validation_failed' && /"surprise" is not defined in the schema/.test(error.message),
      );

      // Valid document passes; defaults are applied for missing fields.
      const result = await database.createDocument('products', { name: 'Aurora', price: 19.9 });
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.body.data.published, false);
    });

    it('reports a controlled error for select fields declared without options', async function () {
      const { database } = createDatabase();

      // A select default without options is refused at definition time
      // (the default could never match) instead of crashing later writes.
      await assert.rejects(
        database.createCollection({
          name: 'broken',
          fields: [{ name: 'state', type: 'select', required: false, default: 'on' }],
        }),
        (error) => error.code === 'invalid_collection_field_default',
      );

      // A select field without options or default is accepted, but writes
      // fail with the controlled schema error — never an internal crash.
      await database.createCollection({
        name: 'opaque',
        fields: [{ name: 'state', type: 'select', required: false }],
      });
      await assert.rejects(
        database.createDocument('opaque', { state: 'on' }),
        (error) => error.code === 'schema_validation_failed'
          && /must be one of the declared options/.test(error.message),
      );
    });

    it('enforces datetime, file, and json field types', async function () {
      const { database } = createDatabase();
      await database.createCollection({
        name: 'events',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'starts_at', type: 'datetime', required: true },
          { name: 'asset', type: 'file', required: false },
          { name: 'meta', type: 'json', required: false },
        ],
      });
      await assert.rejects(
        database.createDocument('events', { title: 'T', starts_at: 'yesterday' }),
        (error) => error.code === 'schema_validation_failed' && /"starts_at" must be an ISO 8601 datetime/.test(error.message),
      );
      await assert.rejects(
        database.createDocument('events', { title: 'T', starts_at: '2026-09-20T00:00:00.000Z', asset: { key: 'a.png' } }),
        (error) => error.code === 'schema_validation_failed' && /"asset" must be a string object key reference/.test(error.message),
      );
      const ok = await database.createDocument('events', {
        title: 'T',
        starts_at: '2026-09-20T00:00:00.000Z',
        asset: 'assets/a.png',
        meta: { anything: 'goes' },
      });
      assert.strictEqual(ok.status, 201);
      assert.deepStrictEqual(ok.body.data.meta, { anything: 'goes' });
    });

    it('keeps versioning and idempotency intact for schema-validated writes', async function () {
      const { database, journal } = createDatabase();
      await database.createCollection(PRODUCTS_SCHEMA);
      const first = await database.createDocument('products', { name: 'Aurora', price: 1 }, { idempotencyKey: 'idem-1' });
      assert.strictEqual(first.body.version, 1);
      const retried = await database.createDocument('products', { name: 'Aurora', price: 1 }, { idempotencyKey: 'idem-1' });
      assert.strictEqual(retried.body.data.id, first.body.data.id);
      assert.strictEqual(journal.entries.length, 1, 'idempotent retry must not append another revision');

      const patched = await database.patchDocument('products', first.body.data.id, { price: 2 }, {
        expectedVersion: 1,
        idempotencyKey: 'idem-2',
      });
      assert.strictEqual(patched.body.version, 2);
      assert.strictEqual(patched.body.data.price, 2);
    });
  });

  describe('schema enforcement on patch', function () {
    async function seedLegacyRecord(database) {
      // Schema defined AFTER the record exists: the record carries a field
      // outside the schema and lacks a required field.
      await database.createDocument('migrated', { legacy_field: 'keep-me', name: 'Old' });
      await database.createCollection({
        name: 'migrated',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'score', type: 'number', required: true },
        ],
      });
      return database.getDocument('migrated', (await database.listDocuments('migrated', {})).data[0].data.id);
    }

    it('lets legacy records stay readable and enforces rules on the merged write', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);
      // The legacy field survives untouched on read.
      assert.strictEqual(record.body.data.legacy_field, 'keep-me');

      // A patch that only updates a known field still fails: the merged
      // document lacks the required "score".
      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { name: 'New' }, { expectedVersion: record.body.version }),
        (error) => error.code === 'schema_validation_failed' && /"score" is required/.test(error.message),
      );

      // Providing the required field succeeds; the legacy field persists.
      const patched = await database.patchDocument('migrated', record.body.data.id, { name: 'New', score: 3 }, {
        expectedVersion: record.body.version,
      });
      assert.strictEqual(patched.body.version, 2);
      assert.strictEqual(patched.body.data.legacy_field, 'keep-me');
      assert.strictEqual(patched.body.data.score, 3);
    });

    it('rejects patches that add fields outside the schema or violate types', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);
      const version = record.body.version;

      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { brand_new: 1, score: 1 }, { expectedVersion: version }),
        (error) => error.code === 'schema_validation_failed' && /"brand_new" is not defined in the schema/.test(error.message),
      );
      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { score: 'high' }, { expectedVersion: version }),
        (error) => error.code === 'schema_validation_failed' && /"score" must be a number/.test(error.message),
      );
    });

    it('preserves version-conflict semantics alongside schema validation', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);
      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { name: 'New', score: 1 }, { expectedVersion: record.body.version + 5 }),
        (error) => error.code === 'version_conflict',
      );
    });
  });

  // -------------------------------------------------------------- route level
  describe('per-collection management routes', function () {
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
      return { env, projects, project, database, journal };
    }

    function withFixture(fn) {
      return (async () => {
        const reference = await fixture();
        return fn(reference);
      })();
    }

    it('gets, patches, and deletes a collection through the project route', async function () {
      const result = await withFixture(async (reference) => {
        const { env, project, database, projects } = reference;
        await database.createCollection(PRODUCTS_SCHEMA);

        let res = await (async () => {
          const request = new Request('https://console.example/api');
          return modules.projectsMiddleware.projectErrorHandling({
            request,
            env,
            params: { id: project.project_id, name: 'products' },
            data: { projectDatabase: database, projectRegistry: projects },
            next: () => modules.collectionNameRoute.onRequestGet({
              request, env, params: { id: project.project_id, name: 'products' },
              data: { projectDatabase: database, projectRegistry: projects },
            }),
          });
        })();
        assert.strictEqual(res.status, 200);
        let body = await res.json();
        assert.strictEqual(body.name, 'products');
        assert.strictEqual(body.fields.length, 4);

        // PATCH: define a new schema shape.
        res = await (async () => {
          const request = new Request('https://console.example/api', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'v2', fields: [{ name: 'sku', type: 'text', required: true }] }),
          });
          const context = {
            request, env, params: { id: project.project_id, name: 'products' },
            data: { projectDatabase: database, projectRegistry: projects },
          };
          return modules.projectsMiddleware.projectErrorHandling({ ...context, next: () => modules.collectionNameRoute.onRequestPatch(context) });
        })();
        assert.strictEqual(res.status, 200);
        body = await res.json();
        assert.strictEqual(body.description, 'v2');
        assert.deepStrictEqual(body.fields.map((f) => f.name), ['sku']);

        // DELETE after removing records: create one record, delete it, then
        // the collection deletes cleanly.
        await database.createDocument('products', { sku: 'SKU-1' });
        const listed = await database.listDocuments('products', {});
        await database.deleteDocument('products', listed.data[0].data.id, { expectedVersion: listed.data[0].version });

        res = await (async () => {
          const request = new Request('https://console.example/api', { method: 'DELETE' });
          const context = {
            request, env, params: { id: project.project_id, name: 'products' },
            data: { projectDatabase: database, projectRegistry: projects },
          };
          return modules.projectsMiddleware.projectErrorHandling({ ...context, next: () => modules.collectionNameRoute.onRequestDelete(context) });
        })();
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { deleted: true, name: 'products' });

        // DELETE again: 404.
        res = await (async () => {
          const request = new Request('https://console.example/api', { method: 'DELETE' });
          const context = {
            request, env, params: { id: project.project_id, name: 'products' },
            data: { projectDatabase: database, projectRegistry: projects },
          };
          return modules.projectsMiddleware.projectErrorHandling({ ...context, next: () => modules.collectionNameRoute.onRequestDelete(context) });
        })();
        assert.strictEqual(res.status, 404);
        assert.strictEqual((await res.json()).error, 'collection_not_found');

        return { project, database };
      });
      assert.ok(result);
    });

    it('returns a controlled 409 for deleting a non-empty collection', async function () {
      await withFixture(async ({ env, project, database, projects }) => {
        await database.createCollection({ name: 'busy', fields: [] });
        await database.createDocument('busy', { x: 1 });
        const request = new Request('https://console.example/api', { method: 'DELETE' });
        const context = {
          request, env, params: { id: project.project_id, name: 'busy' },
          data: { projectDatabase: database, projectRegistry: projects },
        };
        const res = await modules.projectsMiddleware.projectErrorHandling({
          ...context,
          next: () => modules.collectionNameRoute.onRequestDelete(context),
        });
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).error, 'collection_not_empty');
      });
    });
  });
});
