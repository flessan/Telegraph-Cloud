const assert = require('assert');
const { createMockKV, muteConsole } = require('./helpers');

function fixedClock() {
  return new Date('2026-09-21T09:00:00.000Z');
}

function createJournal() {
  const entries = [];
  return {
    entries,
    validateConfig() {},
    async appendJson(payload) {
      if (this.failure) throw this.failure;
      entries.push(JSON.parse(JSON.stringify(payload)));
      return { provider: 'telegram-journal', fileId: `journal_${entries.length}`, messageId: entries.length };
    },
  };
}

// A schema exercising every field type, including required flags, defaults of
// every falsy shape, and a select with options.
const INVENTORY_SCHEMA = {
  name: 'inventory',
  description: 'Every field type',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'price', type: 'number', required: true, default: 0 },
    { name: 'published', type: 'boolean', default: false },
    { name: 'released_at', type: 'datetime' },
    { name: 'meta', type: 'json' },
    { name: 'cover', type: 'file' },
    { name: 'status', type: 'select', required: true, options: ['draft', 'live', 'archived'], default: 'draft' },
  ],
};

// A minimal valid document for INVENTORY_SCHEMA: everything else comes from
// defaults.
const MINIMAL_VALID = { title: 'Aurora', status: 'draft' };

describe('Telegraph Cloud schema enforcement on records', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      index: await import('../functions/cloud/index-store.js'),
      db: await import('../functions/cloud/document-database.js'),
      projectsMiddleware: await import('../functions/api/projects/_middleware.js'),
      collectionRoute: await import('../functions/api/projects/[id]/db/[collection]/index.js'),
    };
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createDatabase({ env: extraEnv = {}, projectId = null, kv: injectedKv = null } = {}) {
    const kv = injectedKv || createMockKV();
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

  // ------------------------------------------------------- create-path rules
  describe('create validation', function () {
    it('enforces every field type on create', async function () {
      const { database } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);

      const invalid = [
        ['title', 42, 'must be a string'],
        ['price', '19.90', 'must be a number'],
        ['published', 'yes', 'must be a boolean'],
        ['released_at', '2026-09-21', 'must be an ISO 8601 datetime'],
        ['cover', { bucket: 'assets', key: 'a.png' }, 'must be a string object key reference'],
        ['status', 'clearance', 'must be one of: draft, live, archived'],
      ];
      for (const [field, value, problem] of invalid) {
        await assert.rejects(
          database.createDocument('inventory', { ...MINIMAL_VALID, [field]: value }),
          (error) => error.code === 'schema_validation_failed'
            && error.status === 400
            && error.message.includes(`"${field}" ${problem}`),
          `${field} = ${JSON.stringify(value)} must be rejected`,
        );
      }

      // The valid document passes and stores type-correct values.
      const result = await database.createDocument('inventory', {
        ...MINIMAL_VALID,
        released_at: '2026-09-21T00:00:00.000Z',
        meta: { tags: ['a'] },
        cover: 'assets/a.png',
      });
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.body.data.cover, 'assets/a.png');
    });

    it('rejects null for scalar fields and accepts it for json fields', async function () {
      const { database } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);

      for (const field of ['title', 'price', 'published', 'released_at', 'cover', 'status']) {
        await assert.rejects(
          database.createDocument('inventory', { ...MINIMAL_VALID, [field]: null }),
          (error) => error.code === 'schema_validation_failed'
            && error.message.includes(`"${field}" must be`),
          `${field} = null must be rejected`,
        );
      }
      const result = await database.createDocument('inventory', { ...MINIMAL_VALID, meta: null });
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.body.data.meta, null);
    });

    it('rejects fields outside the schema on create', async function () {
      const { database } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);
      await assert.rejects(
        database.createDocument('inventory', { ...MINIMAL_VALID, surprise: true }),
        (error) => error.code === 'schema_validation_failed'
          && /"surprise" is not defined in the schema/.test(error.message),
      );
    });

    it('applies falsy defaults (0, false, empty text) and select defaults on create', async function () {
      const { database } = createDatabase();
      await database.createCollection({
        name: 'defaults',
        fields: [
          { name: 'count', type: 'number', default: 0 },
          { name: 'enabled', type: 'boolean', default: false },
          { name: 'label', type: 'text', default: '' },
          { name: 'extra', type: 'json', default: { source: 'schema' } },
          { name: 'state', type: 'select', options: ['off', 'on'], default: 'off' },
        ],
      });

      const result = await database.createDocument('defaults', {});
      assert.strictEqual(result.status, 201);
      assert.strictEqual(result.body.data.count, 0);
      assert.strictEqual(result.body.data.enabled, false);
      assert.strictEqual(result.body.data.label, '');
      assert.deepStrictEqual(result.body.data.extra, { source: 'schema' });
      assert.strictEqual(result.body.data.state, 'off');
    });

    it('keeps explicit values over defaults and stores the defaulted document in the journal', async function () {
      const { database, kv } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);

      const result = await database.createDocument('inventory', {
        title: 'Aurora', status: 'live', price: 5, published: true,
      });
      assert.strictEqual(result.body.data.price, 5);
      assert.strictEqual(result.body.data.published, true);
      assert.strictEqual(result.body.data.status, 'live');

      // The materialized index record carries the same validated document.
      const key = `tc:v1:db-record:inventory:${result.body.data.id}`;
      const stored = JSON.parse(kv.snapshot(key).value);
      assert.strictEqual(stored.document.price, 5);
      assert.strictEqual(stored.document.published, true);
    });
  });

  // -------------------------------------------------------- patch-path rules
  describe('patch validation', function () {
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
      const listed = await database.listDocuments('migrated', {});
      return database.getDocument('migrated', listed.data[0].data.id);
    }

    it('validates the merged document but tolerates legacy fields it does not touch', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);

      const patched = await database.patchDocument(
        'migrated', record.body.data.id, { score: 10 }, { expectedVersion: record.body.version },
      );
      assert.strictEqual(patched.status, 200);
      assert.strictEqual(patched.body.data.score, 10);
      assert.strictEqual(patched.body.data.legacy_field, 'keep-me', 'legacy field survives');
      assert.strictEqual(patched.body.version, record.body.version + 1);
    });

    it('rejects wrong types and new out-of-schema fields introduced by a patch', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);

      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { score: 'high' }, { expectedVersion: record.body.version }),
        (error) => error.code === 'schema_validation_failed' && /"score" must be a number/.test(error.message),
      );
      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { brand_new: 1 }, { expectedVersion: record.body.version }),
        (error) => error.code === 'schema_validation_failed'
          && /"brand_new" is not defined in the schema and cannot be added by an update/.test(error.message),
      );

      // Failed patches leave the record untouched at its current version.
      const after = await database.getDocument('migrated', record.body.data.id);
      assert.strictEqual(after.body.version, record.body.version);
      assert.strictEqual(after.body.data.score, undefined);
    });

    it('enforces required fields on the merged document for legacy records', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database); // lacks required "score"

      await assert.rejects(
        database.patchDocument('migrated', record.body.data.id, { name: 'Renamed' }, { expectedVersion: record.body.version }),
        (error) => error.code === 'schema_validation_failed' && /"score" is required/.test(error.message),
      );

      // Supplying the required field in the same patch satisfies the schema.
      const patched = await database.patchDocument(
        'migrated', record.body.data.id, { name: 'Renamed', score: 1 }, { expectedVersion: record.body.version },
      );
      assert.strictEqual(patched.body.data.name, 'Renamed');
      assert.strictEqual(patched.body.data.score, 1);
    });

    it('does not inject defaults when patching a record that predates them', async function () {
      const { database } = createDatabase();
      await database.createDocument('defaults', { count: 3 }); // no "state" yet
      await database.createCollection({
        name: 'defaults',
        fields: [
          { name: 'count', type: 'number', required: true },
          { name: 'state', type: 'select', options: ['off', 'on'], default: 'off' },
        ],
      });
      const listed = await database.listDocuments('defaults', {});
      const record = listed.data[0];

      const patched = await database.patchDocument(
        'defaults', record.data.id, { count: 4 }, { expectedVersion: record.version },
      );
      assert.strictEqual(patched.status, 200);
      assert.strictEqual(patched.body.data.count, 4);
      assert.strictEqual(patched.body.data.state, undefined,
        'defaults apply on create only; existing records are never implicitly rewritten');
    });

    it('returns version_conflict before schema problems when the expected version is stale', async function () {
      const { database } = createDatabase();
      const record = await seedLegacyRecord(database);

      await assert.rejects(
        database.patchDocument(
          'migrated', record.body.data.id,
          { score: 'not-a-number', brand_new: true }, // invalid AND stale
          { expectedVersion: record.body.version + 9 },
        ),
        (error) => error.code === 'version_conflict' && error.status === 409,
      );
    });
  });

  // --------------------------------------- idempotency & recovery with schema
  describe('idempotency and recovery with schemas', function () {
    it('replays the same Idempotency-Key to the same defaulted result without a second journal entry', async function () {
      const { database, journal, kv } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);

      const first = await database.createDocument('inventory', MINIMAL_VALID, { idempotencyKey: 'schema-idem-001' });
      assert.strictEqual(first.status, 201);
      assert.strictEqual(first.body.data.price, 0);
      assert.strictEqual(first.body.data.published, false);
      assert.strictEqual(first.body.data.status, 'draft');
      assert.strictEqual(journal.entries.length, 1);

      const retry = await database.createDocument('inventory', MINIMAL_VALID, { idempotencyKey: 'schema-idem-001' });
      assert.deepStrictEqual(retry.body, first.body);
      assert.strictEqual(journal.entries.length, 1, 'no additional journal revision for the replay');

      const appliedReceipt = kv.operations.put.findLast((operation) => (
        operation.key.startsWith('tc:v1:db-outbox:')
        && JSON.parse(operation.value).status === 'applied'
      ));
      assert.ok(appliedReceipt, 'applied outbox receipt written');
      assert.strictEqual(appliedReceipt.expirationTtl, 7 * 24 * 60 * 60);

      await assert.rejects(
        () => database.createDocument('inventory', { title: 'Different', status: 'live' }, { idempotencyKey: 'schema-idem-001' }),
        (error) => error && error.code === 'idempotency_key_reused' && error.status === 409,
      );
    });

    it('recovers a schema-validated create through the same Idempotency-Key after an index failure', async function () {
      const kv = createMockKV();
      const originalPut = kv.put.bind(kv);
      let failMaterialization = true;
      kv.put = async (key, value, options) => {
        if (failMaterialization && key.startsWith('tc:v1:db-collection:')) {
          throw new Error('KV write includes sensitive diagnostic details');
        }
        return originalPut(key, value, options);
      };
      const { database, journal } = createDatabase({ kv });
      await database.createCollection(INVENTORY_SCHEMA);

      // Validation and defaults happen before the journal append, so the
      // journaled revision is the canonical validated document.
      await assert.rejects(
        () => database.createDocument('inventory', MINIMAL_VALID, { idempotencyKey: 'schema-recover-001' }),
        (error) => error && error.code === 'mutation_pending' && error.status === 503,
      );
      assert.strictEqual(journal.entries.length, 1);

      failMaterialization = false;
      const recovered = await database.createDocument('inventory', MINIMAL_VALID, { idempotencyKey: 'schema-recover-001' });
      assert.strictEqual(recovered.status, 201);
      // The recovered record is exactly the validated revision: defaults
      // present, no re-validation divergence, no second record.
      assert.strictEqual(recovered.body.data.price, 0);
      assert.strictEqual(recovered.body.data.published, false);
      assert.strictEqual(recovered.body.data.status, 'draft');
      assert.strictEqual(journal.entries.length, 1, 'recovery reuses the journal pointer');

      const listed = await database.listDocuments('inventory', {});
      assert.strictEqual(listed.data.length, 1);
    });

    it('never appends to the journal when schema validation fails', async function () {
      const { database, journal } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);

      await assert.rejects(
        database.createDocument('inventory', { title: 'Aurora', status: 'clearance' }),
        (error) => error.code === 'schema_validation_failed',
      );
      assert.deepStrictEqual(journal.entries, [], 'invalid documents never reach the journal');
    });
  });

  // ------------------------------------------------- empty-string regression
  describe('empty-string values (filter-index regression)', function () {
    // Regression: base64url('') is the empty string, which failed the index
    // key segment charset. Any document with an empty-string top-level field
    // journaled fine but could never materialize (permanent mutation_pending).
    it('materializes records with empty-string fields and keeps them filterable', async function () {
      const { database } = createDatabase();
      await database.createCollection({
        name: 'labels',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'note', type: 'text', default: '' },
        ],
      });

      const created = await database.createDocument('labels', { name: 'Aurora' });
      assert.strictEqual(created.status, 201);
      assert.strictEqual(created.body.data.note, '', 'empty default applied');

      // The empty value is exactly queryable.
      const listed = await database.listDocuments('labels', { filters: { note: '' } });
      assert.strictEqual(listed.data.length, 1);
      assert.strictEqual(listed.data[0].data.name, 'Aurora');

      const nonEmpty = await database.listDocuments('labels', { filters: { note: 'x' } });
      assert.strictEqual(nonEmpty.data.length, 0);
    });

    it('accepts empty strings introduced by a patch and through schema-less writes', async function () {
      const { database } = createDatabase();
      await database.createCollection({ name: 'keep', fields: [{ name: 'tag', type: 'text' }] });
      const created = await database.createDocument('keep', { tag: 'x' });

      const patched = await database.patchDocument(
        'keep', created.body.data.id, { tag: '' }, { expectedVersion: created.body.version },
      );
      assert.strictEqual(patched.status, 200);
      assert.strictEqual(patched.body.data.tag, '');

      const free = await database.createDocument('freeform', { note: '' });
      assert.strictEqual(free.status, 201);
      const listed = await database.listDocuments('freeform', { filters: { note: '' } });
      assert.strictEqual(listed.data.length, 1);
    });
  });

  // -------------------------------------------------- schema-less coexistence
  describe('schema-less collections keep working', function () {
    it('accepts arbitrary JSON in a schema-less sibling while enforcing the schema elsewhere', async function () {
      const { database } = createDatabase();
      await database.createCollection(INVENTORY_SCHEMA);
      // No metadata is created for 'freeform' at all.

      const free = await database.createDocument('freeform', {
        anything: ['goes', 1, true, null],
        title: 42, status: 'not-a-real-option', surprise: { nested: true },
      });
      assert.strictEqual(free.status, 201);
      assert.deepStrictEqual(free.body.data.anything, ['goes', 1, true, null]);

      await assert.rejects(
        database.createDocument('inventory', { anything: ['goes'] }),
        (error) => error.code === 'schema_validation_failed',
      );
      const listed = await database.listDocuments('freeform', {});
      assert.strictEqual(listed.data.length, 1);
    });
  });

  // ------------------------------------------------------------- HTTP surface
  describe('project-scoped HTTP route', function () {
    async function fixture() {
      const kv = createMockKV();
      const env = { TELEGRAPH_CLOUD_KV: kv };
      const index = modules.index.createCloudIndexStore(env);
      const journal = createJournal();
      const projects = (await import('../functions/cloud/project-registry.js'))
        .createProjectRegistry(env, { index, now: fixedClock });
      const project = await projects.createProject({ slug: 'enforce', name: 'Enforce' });
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

    function postRecord(reference, collection, payload) {
      const { env, project, database, projects } = reference;
      const request = new Request(`https://console.example/api/projects/${project.project_id}/db/${collection}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const context = {
        request,
        env,
        params: { id: project.project_id, collection },
        data: { projectDatabase: database, projectRegistry: projects },
      };
      return modules.projectsMiddleware.projectErrorHandling({
        ...context,
        next: () => modules.collectionRoute.onRequest(context),
      });
    }

    it('returns a safe 400 for schema violations and 201 with defaults for valid records', async function () {
      const reference = await fixture();
      await reference.database.createCollection(INVENTORY_SCHEMA);

      const bad = await postRecord(reference, 'inventory', { title: 'Aurora', status: 'clearance' });
      assert.strictEqual(bad.status, 400);
      const badBody = await bad.json();
      assert.deepStrictEqual(badBody, { error: 'schema_validation_failed' });

      const good = await postRecord(reference, 'inventory', { title: 'Aurora', status: 'draft' });
      assert.strictEqual(good.status, 201);
      const goodBody = await good.json();
      assert.strictEqual(goodBody.data.price, 0);
      assert.strictEqual(goodBody.data.published, false);
      assert.strictEqual(goodBody.data.status, 'draft');
    });
  });
});
