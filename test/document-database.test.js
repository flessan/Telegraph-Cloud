const assert = require('assert');
const { createMockKV } = require('./helpers');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createJournal() {
  const entries = [];
  const journal = {
    entries,
    failure: null,
    validateConfig() {
      if (journal.failure === 'config') throw new Error('TG_Bot_Token=private-token');
    },
    async appendJson(payload) {
      if (journal.failure) {
        if (journal.failure instanceof Error) throw journal.failure;
        throw new Error('Telegram request failed with a private-token');
      }
      entries.push(clone(payload));
      return {
        provider: 'telegram-journal',
        fileId: `AgACDocumentRevision_${entries.length}`,
        messageId: entries.length,
      };
    },
  };
  return journal;
}

describe('Telegram-backed document database', function () {
  let databaseModule;
  let indexModule;

  before(async function () {
    databaseModule = await import('../functions/cloud/document-database.js');
    indexModule = await import('../functions/cloud/index-store.js');
  });

  function createDatabase({ env: extraEnv = {}, kv = createMockKV(), journal = createJournal() } = {}) {
    const env = { TELEGRAPH_CLOUD_KV: kv, ...extraEnv };
    let generated = 0;
    let tick = 0;
    const index = indexModule.createCloudIndexStore(env);
    const database = databaseModule.createTelegramDocumentDatabase(env, {
      index,
      journal,
      createId(prefix) {
        generated += 1;
        return `${prefix}${String(generated).padStart(22, '0')}`;
      },
      now() {
        const date = new Date(Date.UTC(2026, 8, 12, 0, 0, tick));
        tick += 1;
        return date;
      },
    });
    return { database, env, kv, journal };
  }

  it('creates a server-identified immutable revision and returns no Telegram pointer', async function () {
    const { database, kv, journal } = createDatabase();

    const result = await database.createDocument('users', {
      name: 'Thio',
      role: 'admin',
    }, { idempotencyKey: 'create-thio-001' });

    assert.strictEqual(result.status, 201);
    assert.strictEqual(result.etag, '"1"');
    assert.strictEqual(result.body.version, 1);
    assert.strictEqual(result.body.data.name, 'Thio');
    assert.strictEqual(result.body.data.role, 'admin');
    assert.match(result.body.data.id, /^rec_[A-Za-z0-9_-]+$/);
    assert.ok(!JSON.stringify(result).includes('AgACDocumentRevision_1'));

    assert.strictEqual(journal.entries.length, 1);
    assert.deepStrictEqual(journal.entries[0], {
      schema: 'telegraph-cloud.record.v1',
      event_id: `evt_${String(2).padStart(22, '0')}`,
      collection: 'users',
      record_id: result.body.data.id,
      operation: 'create',
      version: 1,
      parent: null,
      created_at: '2026-09-12T00:00:00.000Z',
      updated_at: '2026-09-12T00:00:00.000Z',
      deleted: false,
      document: {
        id: result.body.data.id,
        name: 'Thio',
        role: 'admin',
      },
    });

    const current = JSON.parse(kv.snapshot(`tc:v1:db-record:users:${result.body.data.id}`).value);
    assert.strictEqual(current.version, 1);
    assert.strictEqual(current.journal_pointer.fileId, 'AgACDocumentRevision_1');
    assert.strictEqual(current.journal_pointer.messageId, 1);
    assert.strictEqual(current.deleted, false);
  });

  it('reads current records and lists a bounded equality-index page in deterministic ID order', async function () {
    const { database } = createDatabase();
    const first = await database.createDocument('users', { name: 'Ada', role: 'admin' });
    await database.createDocument('users', { name: 'Bo', role: 'member' });
    const third = await database.createDocument('users', { name: 'Cy', role: 'admin' });

    const fetched = await database.getDocument('users', first.body.data.id);
    assert.strictEqual(fetched.status, 200);
    assert.deepStrictEqual(fetched.body.data, first.body.data);
    assert.strictEqual(fetched.etag, '"1"');

    const pageOne = await database.listDocuments('users', {
      filters: { role: 'admin' },
      limit: 1,
    });
    assert.strictEqual(pageOne.order, 'id:asc');
    assert.strictEqual(pageOne.limit, 1);
    assert.strictEqual(pageOne.data.length, 1);
    assert.strictEqual(pageOne.data[0].data.id, first.body.data.id);
    assert.strictEqual(pageOne.has_more, true);
    assert.ok(pageOne.next_cursor);

    const pageTwo = await database.listDocuments('users', {
      filters: { role: 'admin' },
      limit: 1,
      cursor: pageOne.next_cursor,
    });
    assert.strictEqual(pageTwo.data.length, 1);
    assert.strictEqual(pageTwo.data[0].data.id, third.body.data.id);
    assert.strictEqual(pageTwo.has_more, false);

    await assert.rejects(
      () => database.listDocuments('users', {
        filters: { role: 'member' },
        limit: 1,
        cursor: pageOne.next_cursor,
      }),
      (error) => error && error.code === 'invalid_cursor',
    );
  });

  it('writes a full immutable update revision and preserves the original journal event', async function () {
    const { database, journal } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio', role: 'admin' });
    const originalEvent = clone(journal.entries[0]);

    const updated = await database.patchDocument('users', created.body.data.id, {
      role: 'member',
      preferences: { theme: 'dark' },
    }, {
      expectedVersion: 1,
      idempotencyKey: 'patch-thio-001',
    });

    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.etag, '"2"');
    assert.strictEqual(updated.body.version, 2);
    assert.deepStrictEqual(updated.body.data, {
      id: created.body.data.id,
      name: 'Thio',
      role: 'member',
      preferences: { theme: 'dark' },
    });
    assert.deepStrictEqual(journal.entries[0], originalEvent);
    assert.strictEqual(journal.entries[1].operation, 'update');
    assert.strictEqual(journal.entries[1].version, 2);
    assert.deepStrictEqual(journal.entries[1].parent, {
      event_id: journal.entries[0].event_id,
      version: 1,
    });
    assert.deepStrictEqual(journal.entries[1].document, updated.body.data);
  });

  it('returns an optimistic-concurrency conflict instead of silently overwriting a newer revision', async function () {
    const { database } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio', role: 'admin' });
    await database.patchDocument('users', created.body.data.id, { role: 'member' }, { expectedVersion: 1 });

    await assert.rejects(
      () => database.patchDocument('users', created.body.data.id, { role: 'owner' }, { expectedVersion: 1 }),
      (error) => error
        && error.code === 'version_conflict'
        && error.status === 409
        && error.details?.current_version === 2,
    );
  });

  it('uses the lower opaque event ID as the deterministic winner of a same-parent version fork', async function () {
    const { database, journal, kv } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio', role: 'admin' });
    const recordId = created.body.data.id;
    const original = JSON.parse(kv.snapshot(`tc:v1:db-record:users:${recordId}`).value);
    const foreignEventId = `evt_${'z'.repeat(22)}`;
    const foreignPointer = {
      provider: 'telegram-journal',
      fileId: 'AgACDocumentRevision_foreign',
      messageId: 99,
    };
    const foreignRevision = {
      schema: 'telegraph-cloud.record.v1',
      event_id: foreignEventId,
      collection: 'users',
      record_id: recordId,
      operation: 'update',
      version: 2,
      parent: { event_id: original.event_id, version: 1 },
      created_at: original.created_at,
      updated_at: '2026-09-12T00:00:01.000Z',
      deleted: false,
      document: { id: recordId, name: 'Thio', role: 'foreign' },
    };
    journal.entries.push(clone(foreignRevision));
    await kv.put(`tc:v1:db-revision:users:${recordId}:2`, JSON.stringify({
      schema: 'telegraph-cloud.revision-index.v1',
      collection: 'users',
      record_id: recordId,
      version: 2,
      event_id: foreignEventId,
      parent_event_id: original.event_id,
      operation: 'update',
      created_at: foreignRevision.created_at,
      updated_at: foreignRevision.updated_at,
      deleted: false,
      journal_pointer: foreignPointer,
    }));
    await kv.put(`tc:v1:db-record:users:${recordId}`, JSON.stringify({
      ...original,
      version: 2,
      updated_at: foreignRevision.updated_at,
      event_id: foreignEventId,
      parent_event_id: original.event_id,
      journal_pointer: foreignPointer,
      document: foreignRevision.document,
      query_fields: { name: 'Thio', role: 'foreign' },
    }));
    // Simulate an edge that read version 1 just before the competing child
    // became visible, then sees the fork while materializing its own event.
    const originalGet = kv.get.bind(kv);
    let staleRead = true;
    kv.get = async (key) => {
      if (staleRead && key === `tc:v1:db-record:users:${recordId}`) {
        staleRead = false;
        return JSON.stringify(original);
      }
      return originalGet(key);
    };

    const updated = await database.patchDocument('users', recordId, { role: 'member' }, {
      expectedVersion: 1,
      idempotencyKey: 'same-parent-fork-001',
    });

    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.version, 2);
    assert.strictEqual(updated.body.data.role, 'member');
    assert.strictEqual(journal.entries.length, 3);
    assert.strictEqual(journal.entries[2].event_id < foreignEventId, true);
    const current = JSON.parse(kv.snapshot(`tc:v1:db-record:users:${recordId}`).value);
    assert.strictEqual(current.event_id, journal.entries[2].event_id);
    assert.strictEqual(current.document.role, 'member');
  });

  it('writes a tombstone, hides it from normal reads/lists, and retains immutable history', async function () {
    const { database, journal } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio', role: 'admin' });
    const removed = await database.deleteDocument('users', created.body.data.id, {
      expectedVersion: 1,
      idempotencyKey: 'delete-thio-001',
    });

    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.body.deleted, true);
    assert.strictEqual(removed.body.version, 2);
    assert.strictEqual(removed.body.data.id, created.body.data.id);
    assert.strictEqual(journal.entries.length, 2);
    assert.strictEqual(journal.entries[1].operation, 'delete');
    assert.strictEqual(journal.entries[1].deleted, true);
    assert.deepStrictEqual(journal.entries[1].document, created.body.data);

    await assert.rejects(
      () => database.getDocument('users', created.body.data.id),
      (error) => error && error.code === 'record_not_found' && error.status === 404,
    );
    const list = await database.listDocuments('users', { limit: 20 });
    assert.deepStrictEqual(list.data, []);
  });

  it('deduplicates a repeated mutation with the same Idempotency-Key and rejects key reuse with another request', async function () {
    const { database, journal, kv } = createDatabase();
    const first = await database.createDocument('users', { name: 'Thio', role: 'admin' }, {
      idempotencyKey: 'retry-create-thio-001',
    });
    const retry = await database.createDocument('users', { name: 'Thio', role: 'admin' }, {
      idempotencyKey: 'retry-create-thio-001',
    });

    assert.deepStrictEqual(retry, first);
    assert.strictEqual(journal.entries.length, 1);
    const appliedReceipt = kv.operations.put.findLast((operation) => (
      operation.key.startsWith('tc:v1:db-outbox:')
      && JSON.parse(operation.value).status === 'applied'
    ));
    assert.strictEqual(appliedReceipt.expirationTtl, 7 * 24 * 60 * 60);

    await assert.rejects(
      () => database.createDocument('users', { name: 'Not Thio', role: 'admin' }, {
        idempotencyKey: 'retry-create-thio-001',
      }),
      (error) => error && error.code === 'idempotency_key_reused' && error.status === 409,
    );
  });

  it('keeps an index failure after a Telegram append recoverable through the same idempotency key', async function () {
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

    await assert.rejects(
      () => database.createDocument('users', { name: 'Thio', role: 'admin' }, {
        idempotencyKey: 'recover-create-thio-001',
      }),
      (error) => error && error.code === 'mutation_pending' && error.status === 503,
    );
    assert.strictEqual(journal.entries.length, 1);

    failMaterialization = false;
    const recovered = await database.createDocument('users', { name: 'Thio', role: 'admin' }, {
      idempotencyKey: 'recover-create-thio-001',
    });
    assert.strictEqual(recovered.status, 201);
    assert.strictEqual(recovered.body.data.name, 'Thio');
    assert.strictEqual(journal.entries.length, 1, 'recovery reuses the journal pointer rather than creating another record');
  });

  it('fails safely before materialization when Telegram cannot append a revision', async function () {
    const journal = createJournal();
    journal.failure = new Error('Telegram timeout included private-token-should-not-leak');
    const { database, kv } = createDatabase({ journal });

    await assert.rejects(
      () => database.createDocument('users', { name: 'Thio' }, { idempotencyKey: 'telegram-failure-001' }),
      (error) => error
        && error.code === 'telegram_journal_append_failed'
        && error.status === 502
        && !error.message.includes('private-token-should-not-leak'),
    );
    assert.deepStrictEqual(kv.operations.put.filter(({ key }) => key.startsWith('tc:v1:db-record:')), []);
  });

  it('reports missing Telegram journal configuration without leaking the raw configuration error', async function () {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv };
    const database = databaseModule.createTelegramDocumentDatabase(env, {
      index: indexModule.createCloudIndexStore(env),
    });

    await assert.rejects(
      () => database.createDocument('users', { name: 'Thio' }),
      (error) => error
        && error.code === 'telegram_journal_unavailable'
        && error.status === 503
        && !error.message.includes('TG_Bot_Token'),
    );
  });

  it('fails safely instead of replaying malformed stored record metadata', async function () {
    const { database, kv } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio' });
    const key = `tc:v1:db-record:users:${created.body.data.id}`;
    const current = JSON.parse(kv.snapshot(key).value);
    current.document.parent_event_id = 'internal-value-must-not-be-public-data';
    await kv.put(key, JSON.stringify(current));

    await assert.rejects(
      () => database.getDocument('users', created.body.data.id),
      (error) => error && error.code === 'cloud_index_invalid_record' && error.status === 500,
    );
  });

  it('enforces configured payload, collection, ID, and managed-field boundaries', async function () {
    const { database } = createDatabase({
      env: { TELEGRAPH_CLOUD_MAX_DOCUMENT_BYTES: '1024' },
    });

    await assert.rejects(
      () => database.createDocument('users', { text: 'x'.repeat(2048) }),
      (error) => error && error.code === 'document_too_large' && error.status === 413,
    );
    await assert.rejects(
      () => database.createDocument('Users', { name: 'Thio' }),
      (error) => error && error.code === 'invalid_collection_name',
    );
    await assert.rejects(
      () => database.createDocument('users', { id: 'caller-controlled' }),
      (error) => error && error.code === 'managed_field_not_allowed',
    );
    await assert.rejects(
      () => database.createDocument('users', { parent_event_id: 'caller-controlled' }),
      (error) => error && error.code === 'managed_field_not_allowed',
    );
    await assert.rejects(
      () => database.getDocument('users', '../unsafe'),
      (error) => error && error.code === 'invalid_document_id',
    );

    const constrained = createDatabase({
      env: { TELEGRAPH_CLOUD_MAX_RECORD_ID_LENGTH: '26' },
    });
    const created = await constrained.database.createDocument('users', { name: 'Thio' }, {
      idempotencyKey: 'small-record-id-limit-001',
    });
    assert.strictEqual(created.body.data.id.length, 26);
  });
});
