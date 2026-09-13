const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createJournal() {
  const entries = [];
  return {
    entries,
    validateConfig() {},
    async appendJson(payload) {
      entries.push(clone(payload));
      return {
        provider: 'telegram-journal',
        fileId: `AgACRouteJournal_${entries.length}`,
        messageId: entries.length,
      };
    },
  };
}

describe('Telegraph Cloud document database Pages API', function () {
  let collectionRoute;
  let recordRoute;
  let databaseMiddleware;
  let databaseModule;
  let indexModule;
  let errors;
  let restoreConsole;

  before(async function () {
    collectionRoute = await import('../functions/api/db/[collection]/index.js');
    recordRoute = await import('../functions/api/db/[collection]/[id].js');
    databaseMiddleware = await import('../functions/api/db/_middleware.js');
    databaseModule = await import('../functions/cloud/document-database.js');
    indexModule = await import('../functions/cloud/index-store.js');
    errors = await import('../functions/cloud/errors.js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createDatabase({ env: extraEnv = {} } = {}) {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv, ...extraEnv };
    const journal = createJournal();
    const index = indexModule.createCloudIndexStore(env);
    let id = 0;
    const database = databaseModule.createTelegramDocumentDatabase(env, {
      index,
      journal,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
      now: () => new Date('2026-09-12T12:00:00.000Z'),
    });
    return { database, env, journal };
  }

  function contextFor({ request, env, database, collection = 'users', id }) {
    return makeContext({
      request,
      env,
      params: { collection, ...(id ? { id } : {}) },
      data: { documentDatabase: database },
    });
  }

  async function safeRoute(route, context) {
    return databaseMiddleware.databaseErrorHandling(makeContext({
      request: context.request,
      env: context.env,
      params: context.params,
      data: context.data,
      next: () => route.onRequest(context),
    }));
  }

  it('serves additive POST, GET list, GET record, PATCH, and DELETE routes without Telegram pointer leakage', async function () {
    const { database, env, journal } = createDatabase();
    const post = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Idempotency-Key': 'route-create-001',
        },
        body: JSON.stringify({ name: 'Thio', role: 'admin' }),
      }),
    }));

    assert.strictEqual(post.status, 201);
    assert.strictEqual(post.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(post.headers.get('ETag'), '"1"');
    const created = await post.json();
    assert.strictEqual(created.version, 1);
    assert.match(created.data.id, /^rec_/);
    assert.strictEqual(post.headers.get('Location'), `/api/db/users/${created.data.id}`);
    assert.ok(!JSON.stringify(created).includes('AgACRouteJournal_1'));
    assert.strictEqual(journal.entries.length, 1);

    const list = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users?role=admin&limit=20'),
    }));
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual((await list.json()).data.map((entry) => entry.data), [created.data]);

    const get = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.data.id,
      request: new Request(`https://example.com/api/db/users/${created.data.id}`),
    }));
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.headers.get('ETag'), '"1"');
    assert.deepStrictEqual((await get.json()).data, created.data);

    const patch = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.data.id,
      request: new Request(`https://example.com/api/db/users/${created.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-patch-001' },
        body: JSON.stringify({ _expected_version: 1, role: 'member' }),
      }),
    }));
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.headers.get('ETag'), '"2"');
    const updated = await patch.json();
    assert.deepStrictEqual(updated.data, { ...created.data, role: 'member' });
    assert.strictEqual(updated.version, 2);

    const remove = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.data.id,
      request: new Request(`https://example.com/api/db/users/${created.data.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': '"2"', 'Idempotency-Key': 'route-delete-001' },
      }),
    }));
    assert.strictEqual(remove.status, 200);
    assert.strictEqual(remove.headers.get('ETag'), '"3"');
    assert.deepStrictEqual(await remove.json(), {
      data: { id: created.data.id },
      version: 3,
      created_at: '2026-09-12T12:00:00.000Z',
      updated_at: '2026-09-12T12:00:00.000Z',
      deleted_at: '2026-09-12T12:00:00.000Z',
      deleted: true,
    });

    const gone = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.data.id,
      request: new Request(`https://example.com/api/db/users/${created.data.id}`),
    }));
    assert.strictEqual(gone.status, 404);
    assert.deepStrictEqual(await gone.json(), { error: 'record_not_found' });
  });

  it('requires an explicit matching version and returns the current version on a stale write', async function () {
    const { database, env } = createDatabase();
    const created = await database.createDocument('users', { name: 'Thio', role: 'admin' });
    await database.patchDocument('users', created.body.data.id, { role: 'member' }, { expectedVersion: 1 });

    const missing = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.body.data.id,
      request: new Request(`https://example.com/api/db/users/${created.body.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      }),
    }));
    assert.strictEqual(missing.status, 428);
    assert.deepStrictEqual(await missing.json(), { error: 'precondition_required' });

    const stale = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: created.body.data.id,
      request: new Request(`https://example.com/api/db/users/${created.body.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _expected_version: 1, role: 'owner' }),
      }),
    }));
    assert.strictEqual(stale.status, 409);
    assert.deepStrictEqual(await stale.json(), { error: 'version_conflict', current_version: 2 });
  });

  it('accepts a repeated HTTP Idempotency-Key without appending another journal revision', async function () {
    const { database, env, journal } = createDatabase();
    const makeRequest = () => new Request('https://example.com/api/db/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-retry-create-001' },
      body: JSON.stringify({ name: 'Thio' }),
    });

    const first = await safeRoute(collectionRoute, contextFor({ env, database, request: makeRequest() }));
    const second = await safeRoute(collectionRoute, contextFor({ env, database, request: makeRequest() }));
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    assert.deepStrictEqual(await second.json(), await first.clone().json());
    assert.strictEqual(journal.entries.length, 1);
  });

  it('returns safe client errors for malformed JSON, unsupported content, oversized bodies, invalid paths, and method misuse', async function () {
    const { database, env } = createDatabase({
      env: { TELEGRAPH_CLOUD_MAX_DOCUMENT_BYTES: '1024' },
    });

    const unsupported = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'name=Thio',
      }),
    }));
    assert.strictEqual(unsupported.status, 415);
    assert.deepStrictEqual(await unsupported.json(), { error: 'unsupported_content_type' });

    const malformed = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
      }),
    }));
    assert.strictEqual(malformed.status, 400);
    assert.deepStrictEqual(await malformed.json(), { error: 'malformed_json' });

    const malformedUtf8 = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new Uint8Array([0xff]),
      }),
    }));
    assert.strictEqual(malformedUtf8.status, 400);
    assert.deepStrictEqual(await malformedUtf8.json(), { error: 'malformed_json' });

    const invalidIdempotency = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '' },
        body: JSON.stringify({ name: 'Thio' }),
      }),
    }));
    assert.strictEqual(invalidIdempotency.status, 400);
    assert.deepStrictEqual(await invalidIdempotency.json(), { error: 'invalid_idempotency_key' });

    const prototypeField = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"__proto__":{"polluted":true}}',
      }),
    }));
    assert.strictEqual(prototypeField.status, 400);
    assert.deepStrictEqual(await prototypeField.json(), { error: 'invalid_document_property' });
    assert.strictEqual({}.polluted, undefined);

    const prototypePatch = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: 'rec_safe',
      request: new Request('https://example.com/api/db/users/rec_safe', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{"_expected_version":1,"__proto__":{"polluted":true}}',
      }),
    }));
    assert.strictEqual(prototypePatch.status, 400);
    assert.deepStrictEqual(await prototypePatch.json(), { error: 'invalid_document_property' });
    assert.strictEqual({}.polluted, undefined);

    const invalidDeleteBody = await safeRoute(recordRoute, contextFor({
      env,
      database,
      id: 'rec_safe',
      request: new Request('https://example.com/api/db/users/rec_safe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"1"' },
        body: 'null',
      }),
    }));
    assert.strictEqual(invalidDeleteBody.status, 400);
    assert.deepStrictEqual(await invalidDeleteBody.json(), { error: 'invalid_delete_body' });

    const oversized = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'x'.repeat(2048) }),
      }),
    }));
    assert.strictEqual(oversized.status, 413);
    assert.deepStrictEqual(await oversized.json(), { error: 'document_too_large' });

    const invalidPath = await safeRoute(recordRoute, contextFor({
      env,
      database,
      collection: '../users',
      id: '../private',
      request: new Request('https://example.com/api/db/unsafe'),
    }));
    assert.strictEqual(invalidPath.status, 400);
    assert.deepStrictEqual(await invalidPath.json(), { error: 'invalid_collection_name' });

    const method = await safeRoute(collectionRoute, contextFor({
      env,
      database,
      request: new Request('https://example.com/api/db/users', { method: 'PUT' }),
    }));
    assert.strictEqual(method.status, 405);
    assert.strictEqual(method.headers.get('Allow'), 'GET, POST');
    assert.deepStrictEqual(await method.json(), { error: 'method_not_allowed' });
  });

  it('returns a safe configuration response when the dedicated Cloud KV binding is absent', async function () {
    const response = await safeRoute(collectionRoute, contextFor({
      env: { BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      database: null,
      request: new Request('https://example.com/api/db/users'),
    }));
    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(await response.json(), { error: 'cloud_index_unavailable' });
  });

  it('uses the existing dashboard session/Basic boundary but fails closed until credentials are configured', async function () {
    const missingConfiguration = await databaseMiddleware.databaseAuthentication(makeContext({
      request: new Request('https://example.com/api/db/users'),
      env: { TELEGRAPH_CLOUD_KV: createMockKV() },
    }));
    assert.strictEqual(missingConfiguration.status, 503);
    assert.deepStrictEqual(await missingConfiguration.json(), { error: 'database_auth_not_configured' });

    const unauthenticated = await databaseMiddleware.databaseAuthentication(makeContext({
      request: new Request('https://example.com/api/db/users'),
      env: { TELEGRAPH_CLOUD_KV: createMockKV(), BASIC_USER: 'admin', BASIC_PASS: 'secret' },
    }));
    assert.strictEqual(unauthenticated.status, 401);
    assert.deepStrictEqual(await unauthenticated.json(), { error: 'unauthenticated' });
    assert.strictEqual(unauthenticated.headers.get('WWW-Authenticate'), null);

    const context = makeContext({
      request: new Request('https://example.com/api/db/users', {
        headers: { Authorization: `Basic ${btoa('admin:secret')}` },
      }),
      // Deliberately no legacy img_url binding: the Cloud database uses only
      // its dedicated KV namespace and must not become coupled to the media UI.
      env: { TELEGRAPH_CLOUD_KV: createMockKV(), BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      next: async () => new Response('allowed'),
    });
    const allowed = await databaseMiddleware.databaseAuthentication(context);
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(await allowed.text(), 'allowed');
    assert.deepStrictEqual(context.data.databaseSession, { user: 'admin', basic: true });
  });

  it('applies a bounded in-isolate mutation guard after successful authentication', async function () {
    const user = `rate-test-${Date.now()}`;
    let invoked = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await databaseMiddleware.databaseMutationRateLimit(makeContext({
        request: new Request('https://example.com/api/db/users', { method: 'POST' }),
        data: { databaseSession: { user } },
        next: async () => {
          invoked += 1;
          return new Response('allowed');
        },
      }));
      assert.strictEqual(response.status, 200);
    }
    assert.strictEqual(invoked, 20);

    const limited = await databaseMiddleware.databaseMutationRateLimit(makeContext({
      request: new Request('https://example.com/api/db/users', { method: 'POST' }),
      data: { databaseSession: { user } },
      next: async () => new Response('should not run'),
    }));
    assert.strictEqual(limited.status, 429);
    assert.deepStrictEqual(await limited.json(), { error: 'rate_limited' });
    assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
  });

  it('never exposes an unexpected exception stack or sensitive failure text', async function () {
    const secret = 'bot-token-should-never-appear';
    const response = await databaseMiddleware.databaseErrorHandling(makeContext({
      next: async () => {
        const error = new Error(`Telegram URL contained ${secret}`);
        error.stack = `Error ${secret}\n private stack`;
        throw error;
      },
    }));
    assert.strictEqual(response.status, 500);
    const body = await response.text();
    assert.deepStrictEqual(JSON.parse(body), { error: 'internal_error' });
    assert.ok(!body.includes(secret));
    assert.ok(!body.includes('private stack'));

    const known = await databaseMiddleware.databaseErrorHandling(makeContext({
      next: async () => {
        throw new errors.CloudRequestError('unsupported_content_type', 'contains no public stack', { status: 415 });
      },
    }));
    assert.strictEqual(known.status, 415);
    assert.deepStrictEqual(await known.json(), { error: 'unsupported_content_type' });
  });
});
